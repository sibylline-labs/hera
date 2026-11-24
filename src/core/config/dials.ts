/**
 * `HeraConfig.dials`: a group of operational dials read from one JSON-object Logfire managed
 * variable, merged over the code's defaults, so a Worker's tunable numbers change without a deploy
 * and never stop a request when Logfire cannot answer.
 *
 * `HeraConfig.dialReaders` hands out the `HeraManagedVariables` reader a group reads through, one
 * per `(base, token)`, so every group in an isolate shares one `HeraCache`. Hold the object it
 * returns at module scope (one per isolate).
 *
 * Invariants:
 *  - `read` never fails: each key the variable sets replaces its default whole, a key it leaves out
 *    keeps it, and an unset, unreadable or refused variable answers every default with its reason.
 *  - A token reaches only the host it was configured for: a token with no base reads
 *    `unconfigured` and never fetches; there is no default host.
 *  - Building a group, a memo or a reader does no I/O.
 *  - The timeout is the reader's own: `read` bounds its wait in its own fiber, whatever timeout the
 *    reader it was handed was built with.
 */

import { Redacted } from "effect"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { fn } from "../fn/index.js"
import { managedVariables, type HeraManagedValueReason, type HeraManagedVariables } from "./managed-variables.js"

/** How long a dial reader holds a read: one Logfire call per variable per minute per isolate. */
export const HERA_DIALS_DEFAULT_TTL_MS = 60_000

/** The longest a dial read may wait before it answers the defaults; sized for request paths. */
export const HERA_DIALS_DEFAULT_TIMEOUT_MS = 1_500

/** Where a reading's values came from: the variable, or why the defaults apply. */
export type HeraDialSource = "variable" | HeraManagedValueReason

export interface HeraDialReading<T> {
  readonly values: T
  readonly source: HeraDialSource
}

/** What a group's `overrides` schema may decode to: any subset of the group's keys. A key decoded
 *  as `undefined` (`Schema.optional`) keeps its default, as a missing key does. */
export type HeraDialOverrides<T> = { readonly [K in keyof T]?: T[K] | undefined }

export interface HeraDialsOptions<T extends object, S extends Schema.Top> {
  /** The managed variable's name. */
  readonly name: string
  /** The values in force when the variable is unset, unreadable or refused. */
  readonly defaults: T
  /** Decodes the variable: a struct of the group's keys, each optional and bounded. A value the
   *  schema refuses reads as `invalid` and keeps every default. */
  readonly overrides: S["Type"] extends HeraDialOverrides<T> ? S : never
  readonly timeoutMs?: number | undefined
}

export interface HeraDialGroup<T> {
  readonly name: string
  readonly defaults: T
  /** The values in force, read through `variables`. Never fails. */
  readonly read: (variables: HeraManagedVariables) => Effect.Effect<HeraDialReading<T>>
}

/** `defaults` with each key `overrides` sets to a value replaced whole. */
const merge = <T extends object>(defaults: T, overrides: HeraDialOverrides<T>): T => {
  const values = { ...defaults }
  for (const k of Object.keys(overrides) as (keyof T)[]) {
    const value = overrides[k]
    if (value !== undefined) values[k] = value as T[keyof T]
  }
  return values
}

export function dials<T extends object, S extends Schema.Top>(options: HeraDialsOptions<T, S>): HeraDialGroup<T> {
  const { name, defaults, overrides } = options
  const timeoutMs = options.timeoutMs ?? HERA_DIALS_DEFAULT_TIMEOUT_MS
  const timedOut: HeraDialReading<T> = { values: defaults, source: "unreachable" }

  const fetchReading = fn("HeraConfig.dials.read")(function* (variables: HeraManagedVariables) {
    const got = yield* variables.get(name, overrides as S, {} as S["Type"])
    if (got.source === "fallback") return { values: defaults, source: got.reason } satisfies HeraDialReading<T>
    return { values: merge(defaults, got.value as HeraDialOverrides<T>), source: "variable" } satisfies HeraDialReading<T>
  })

  return {
    name,
    defaults,
    read: (variables) =>
      fetchReading(variables).pipe(
        Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(timedOut) })
      ),
  }
}

export interface HeraDialReadersOptions {
  readonly ttlMs?: number | undefined
  /** Each reader's own HTTP timeout; a group's `timeoutMs` still bounds its read. */
  readonly timeoutMs?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}

/** The env slots a dial reader needs: the Logfire project read key and the host it belongs to. */
export interface HeraDialReaderKey {
  readonly token: string | undefined
  readonly base: string | undefined
}

export interface HeraDialReaders {
  /** The reader for `key`, built on first use and shared after; `unconfigured` when either slot is
   *  missing or blank. */
  readonly reader: (key: HeraDialReaderKey) => HeraManagedVariables
}

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function dialReaders(options: HeraDialReadersOptions = {}): HeraDialReaders {
  const ttlMs = options.ttlMs ?? HERA_DIALS_DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? HERA_DIALS_DEFAULT_TIMEOUT_MS
  const unconfigured = managedVariables({ token: undefined })
  const readers = new Map<string, HeraManagedVariables>()

  return {
    reader: (key) => {
      const token = present(key.token)
      const base = present(key.base)
      if (token === undefined || base === undefined) return unconfigured
      const memoKey = `${base}\u0000${token}`
      const known = readers.get(memoKey)
      if (known !== undefined) return known
      const built = managedVariables({ token: Redacted.make(token), base, ttlMs, timeoutMs, fetch: options.fetch })
      readers.set(memoKey, built)
      return built
    },
  }
}
