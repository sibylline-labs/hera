/**
 * `HeraConfig.managedVariables`: a Logfire managed variable read at runtime, with the
 * caller's code value as the fallback, so a limit or a knob changes without a deploy and never
 * stops a request when Logfire cannot answer.
 *
 * The wire is the one eris reads (eris `src/adapters/logfire.ts`): `GET {base}/v1/variables/{name}/`
 * with `Authorization: Bearer <project key>`, one entry; the key selects the project and the
 * trailing slash is load-bearing. The effective value weighs each `rollout.labels` entry and
 * `latest` (`rollout.latest_weight`); the highest weight wins, a tie goes to `latest`, and a winning
 * label's `serialized_value` is read, else `latest_version`'s.
 *
 * Invariants:
 *  - `get` never fails: every way the read can go wrong answers the fallback with one closed
 *    `reason`, and a value reaches the caller only after it decodes through the caller's schema.
 *  - No token and no response body appears in a reason; a reason is one of six literals.
 *  - A settled read is held per name for `ttlMs` by a `HeraCache`, timed by the Effect `Clock`; a
 *    failed read is an answer like any other and is held for the same TTL, so an outage costs one
 *    call a minute, not one a request. `get`s that miss together each fetch: none waits on another's.
 */

import { Redacted, Result } from "effect"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { makeHeraCache } from "../cache/index.js"
import { fn } from "../fn/index.js"
import { request } from "../http/client.js"
import { decodeResult } from "../schema/index.js"

/** Logfire's US API, where the estate's projects live. */
export const LOGFIRE_DEFAULT_BASE = "https://logfire-us.pydantic.dev"
export const MANAGED_VARIABLE_DEFAULT_TTL_MS = 60_000
export const MANAGED_VARIABLE_DEFAULT_TIMEOUT_MS = 5_000

/** Why a read answered the fallback: no token, no answer, a refusal, no such variable, a body or
 *  value that is not JSON (or not an entry), or JSON the caller's schema refused. */
export type HeraManagedValueReason =
  | "unconfigured"
  | "unreachable"
  | "rejected"
  | "absent"
  | "unparseable"
  | "invalid"

export type HeraManagedValue<T> =
  | { readonly value: T; readonly source: "variable" }
  | { readonly value: T; readonly source: "fallback"; readonly reason: HeraManagedValueReason }

export interface HeraManagedVariablesOptions {
  /** The Logfire project's read key; `undefined` reads every variable as `unconfigured`. */
  readonly token: Redacted.Redacted<string> | undefined
  readonly base?: string | undefined
  readonly ttlMs?: number | undefined
  readonly timeoutMs?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}

export interface HeraManagedVariables {
  /** `name`'s effective value decoded through `schema`, or `fallback` with the reason. */
  readonly get: <S extends Schema.Top>(
    name: string,
    schema: S,
    fallback: S["Type"]
  ) => Effect.Effect<HeraManagedValue<S["Type"]>>
}

const NullableString = Schema.optional(Schema.NullOr(Schema.String))

/** The slice of an entry the effective value reads; every field is optional on the wire. */
const EntrySchema = Schema.Struct({
  latest_version: Schema.optional(Schema.NullOr(Schema.Struct({ serialized_value: NullableString }))),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Record(Schema.String, Schema.NullOr(Schema.Struct({ serialized_value: NullableString })))
    )
  ),
  rollout: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        labels: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Number))),
        latest_weight: Schema.optional(Schema.NullOr(Schema.Number)),
      })
    )
  ),
})
type Entry = Schema.Schema.Type<typeof EntrySchema>

/** The serialized value the rollout serves: the heaviest label's, else the latest version's. */
export function effectiveSerializedValue(entry: Entry): string | null {
  const latest = entry.latest_version?.serialized_value ?? null
  const weights = entry.rollout?.labels ?? {}
  const anyLabelWeighted = Object.values(weights).some((w) => w > 0)
  const latestWeight = entry.rollout?.latest_weight ?? (anyLabelWeighted ? 0 : 1)
  let top: string | null = null
  let topWeight = latestWeight
  for (const [label, weight] of Object.entries(weights)) {
    if (weight > topWeight) {
      top = label
      topWeight = weight
    }
  }
  if (top === null) return latest
  return entry.labels?.[top]?.serialized_value ?? latest
}

/** One read's outcome before the caller's schema: a raw JSON value, or why there is none. */
type Raw = { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly reason: HeraManagedValueReason }

const parseJson = (text: string): Raw => {
  try {
    return { ok: true, json: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, reason: "unparseable" }
  }
}

export function managedVariables(options: HeraManagedVariablesOptions): HeraManagedVariables {
  const base = (options.base ?? LOGFIRE_DEFAULT_BASE).replace(/\/+$/, "")
  const ttlMs = options.ttlMs ?? MANAGED_VARIABLE_DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? MANAGED_VARIABLE_DEFAULT_TIMEOUT_MS

  const fetchRaw = (name: string, token: Redacted.Redacted<string>): Effect.Effect<Raw> =>
    request({
      url: `${base}/v1/variables/${encodeURIComponent(name)}/`,
      method: "GET",
      headers: { authorization: `Bearer ${Redacted.value(token)}`, accept: "application/json" },
      timeoutMs,
      fetch: options.fetch,
    }).pipe(
      Effect.map((res): Raw => {
        const body = parseJson(res.text)
        if (!body.ok) return body
        const entry = decodeResult(EntrySchema, body.json)
        if (Result.isFailure(entry)) return { ok: false, reason: "unparseable" }
        const serialized = effectiveSerializedValue(entry.success)
        return serialized === null ? { ok: false, reason: "absent" } : parseJson(serialized)
      }),
      // HeraHttp fails every non-2xx (a 429 as its own type) and every transport error.
      Effect.catch((error) => {
        const status = "status" in error && typeof error.status === "number" ? error.status : undefined
        if (status === 404) return Effect.succeed<Raw>({ ok: false, reason: "absent" })
        return Effect.succeed<Raw>({ ok: false, reason: status === undefined ? "unreachable" : "rejected" })
      })
    )

  const token = options.token
  const cache =
    token === undefined ? undefined : makeHeraCache({ ttlMs, lookup: (name: string) => fetchRaw(name, token) })

  const read = fn("HeraConfig.managedVariables.read")(function* (name: string) {
    if (cache === undefined) return { ok: false, reason: "unconfigured" } as Raw
    return yield* cache.get(name)
  })

  return {
    get: fn("HeraConfig.managedVariables.get")(function* <S extends Schema.Top>(
      name: string,
      schema: S,
      fallback: S["Type"]
    ) {
      const raw = yield* read(name)
      if (!raw.ok) return { value: fallback, source: "fallback", reason: raw.reason } as HeraManagedValue<S["Type"]>
      const decoded = decodeResult(schema as S & { readonly DecodingServices: never }, raw.json)
      if (Result.isFailure(decoded)) {
        return { value: fallback, source: "fallback", reason: "invalid" } as HeraManagedValue<S["Type"]>
      }
      return { value: decoded.success, source: "variable" } as HeraManagedValue<S["Type"]>
    }),
  }
}
