/**
 * `HeraFlags.ofrep`: per-org flag reads from Logfire's OFREP bulk endpoint.
 *
 * Invariants:
 *  - A settled request is held per context for `ttlMs` by a `HeraCache` this reader owns; a failed
 *    read is an answer like any other and is held as long, so an outage costs one call a minute per
 *    context.
 *  - A read that misses asks Logfire itself, bounded by `timeoutMs`: a Worker request never awaits
 *    another request's fetch.
 *  - After the TTL, the request carries the context's last ETag (`If-None-Match`); a `304` answers
 *    the flags held with that ETag. Logfire's ETag is per context, so it is held per context.
 *  - The token goes only to `base`, and no token or body reaches a reason.
 *  - All state lives in the returned reader; `ofrep()` itself does no I/O.
 */

import { Redacted } from "effect"
import * as Effect from "effect/Effect"
import { HERA_CACHE_DEFAULT_MAX_ENTRIES, makeHeraCache } from "../cache/index.js"
import { request } from "../http/client.js"
import { contextFromKey, contextKey, decodeBulk, requestBody } from "./ofrep-wire.js"
import { fromSource } from "./reader.js"
import type { HeraFlagContext, HeraFlagEvaluation, HeraFlagReader, HeraFlagSnapshot, HeraOfrepOptions } from "./types.js"

export const FLAGS_DEFAULT_TTL_MS = 60_000
export const FLAGS_DEFAULT_TIMEOUT_MS = 5_000
export const OFREP_BULK_PATH = "/v1/ofrep/v1/evaluate/flags"

const UNCONFIGURED: HeraFlagSnapshot = { ok: false, reason: "unconfigured" }

interface Held {
  readonly etag: string
  readonly flags: ReadonlyMap<string, HeraFlagEvaluation>
}

export function ofrep(options: HeraOfrepOptions): HeraFlagReader {
  const url = `${options.base.replace(/\/+$/, "")}${OFREP_BULK_PATH}`
  const ttlMs = options.ttlMs ?? FLAGS_DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? FLAGS_DEFAULT_TIMEOUT_MS
  const maxContexts = options.maxContexts ?? HERA_CACHE_DEFAULT_MAX_ENTRIES
  const token = options.token
  // The last good answer per context, for revalidation; capped like the cache, oldest out first.
  const held = new Map<string, Held>()

  const remember = (key: string, entry: Held): void => {
    held.delete(key)
    held.set(key, entry)
    if (held.size > maxContexts) {
      const oldest = held.keys().next()
      if (oldest.done !== true) held.delete(oldest.value)
    }
  }

  const fetchSnapshot = (key: string, ctx: HeraFlagContext, bearer: Redacted.Redacted<string>) => {
    const prior = held.get(key)
    return request({
      url,
      method: "POST",
      headers: {
        authorization: `Bearer ${Redacted.value(bearer)}`,
        accept: "application/json",
        "content-type": "application/json",
        ...(prior === undefined ? {} : { "if-none-match": prior.etag }),
      },
      body: JSON.stringify(requestBody(ctx)),
      timeoutMs,
      fetch: options.fetch,
    }).pipe(
      Effect.map((res): HeraFlagSnapshot => {
        const flags = decodeBulk(res.text)
        if (flags === undefined) return { ok: false, reason: "unparseable" }
        const etag = res.headers.get("etag")
        if (etag !== null) remember(key, { etag, flags })
        return { ok: true, flags }
      }),
      // HeraHttp fails every non-2xx (a 429 as its own type) and every transport error.
      Effect.catch((error) => {
        const status = "status" in error && typeof error.status === "number" ? error.status : undefined
        if (status === 304 && prior !== undefined) {
          return Effect.succeed<HeraFlagSnapshot>({ ok: true, flags: prior.flags })
        }
        return Effect.succeed<HeraFlagSnapshot>({
          ok: false,
          reason: status === undefined ? "unreachable" : "rejected",
        })
      })
    )
  }

  const warnOptions = { warnWindowMs: ttlMs, maxContexts }
  if (token === undefined) return fromSource(() => Effect.succeed(UNCONFIGURED), warnOptions)

  // Keyed by the canonical context string (strings compare by value in `HeraCache`); the lookup
  // rebuilds the context from it, so a key and its request can never disagree.
  const cache = makeHeraCache({
    ttlMs,
    maxEntries: maxContexts,
    lookup: (key: string) => fetchSnapshot(key, contextFromKey(key), token),
  })
  return fromSource((ctx: HeraFlagContext) => cache.get(contextKey(ctx)), warnOptions)
}
