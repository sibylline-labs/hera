import type { Redacted } from "effect"
import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"

/** An attribute a targeting rule can match on. */
export type HeraFlagAttribute = string | number | boolean

/**
 * Who a flag is evaluated for. The org ULID is the `targetingKey`; HeraFlags also sends it as the
 * `org_id` attribute unless `attributes.org_id` is set, because Logfire override conditions match
 * on attributes.
 */
export interface HeraFlagContext {
  readonly targetingKey: string
  readonly attributes?: Readonly<Record<string, HeraFlagAttribute>> | undefined
}

/**
 * Why a read answered the fallback: no token, no answer, a refusal, no such flag (or no value), an
 * OFREP error entry for the flag, a body that is not OFREP, or a value the caller's schema refused.
 */
export type HeraFlagReason =
  | "unconfigured"
  | "unreachable"
  | "rejected"
  | "absent"
  | "errored"
  | "unparseable"
  | "invalid"

export type HeraFlagValue<T> =
  | { readonly value: T; readonly source: "flag"; readonly variant: string | undefined }
  | { readonly value: T; readonly source: "fallback"; readonly reason: HeraFlagReason }

/** One flag's answer inside a snapshot: a raw JSON value, or why there is none. */
export type HeraFlagEvaluation =
  | { readonly ok: true; readonly value: unknown; readonly variant: string | undefined }
  | { readonly ok: false; readonly reason: "absent" | "errored" }

/** One context's bulk answer: every flag the source resolved, or why the whole read failed. */
export type HeraFlagSnapshot =
  | { readonly ok: true; readonly flags: ReadonlyMap<string, HeraFlagEvaluation> }
  | { readonly ok: false; readonly reason: "unconfigured" | "unreachable" | "rejected" | "unparseable" }

/** Answers a context's snapshot. It never fails: a failure is a snapshot with a reason. */
export type HeraFlagSource = (ctx: HeraFlagContext) => Effect.Effect<HeraFlagSnapshot>

/** How `fromSource` bounds its warn lines. */
export interface HeraFlagSourceOptions {
  /** How long a fallback line suppresses its repeats for one context and cause (default 60 000 ms). */
  readonly warnWindowMs?: number | undefined
  /** The most contexts whose warn history is held (default `HeraCache.DEFAULT_MAX_ENTRIES`). */
  readonly maxContexts?: number | undefined
}

export interface HeraFlagReader {
  /** `name` as a boolean for `ctx`, or `fallback`; a fallback writes one warn line per context and cause per window. */
  readonly bool: (name: string, ctx: HeraFlagContext, fallback: boolean) => Effect.Effect<boolean>
  /** `name` decoded through `schema` for `ctx`, or `fallback`. */
  readonly value: <S extends Schema.Top>(
    name: string,
    schema: S,
    ctx: HeraFlagContext,
    fallback: S["Type"]
  ) => Effect.Effect<S["Type"]>
  /** As `value`, with where the answer came from and, for a fallback, why. */
  readonly evaluate: <S extends Schema.Top>(
    name: string,
    schema: S,
    ctx: HeraFlagContext,
    fallback: S["Type"]
  ) => Effect.Effect<HeraFlagValue<S["Type"]>>
}

export interface HeraOfrepOptions {
  /** A Logfire API key with `project:read_variables`; `undefined` answers every read `unconfigured`. */
  readonly token: Redacted.Redacted<string> | undefined
  /** The Logfire API host the token was minted for (`https://logfire-us.pydantic.dev`). Required:
   *  a bearer goes only to the host it was configured for. */
  readonly base: string
  /** How long a context's answer is held (default 60 000 ms); a failed read is held as long. */
  readonly ttlMs?: number | undefined
  readonly timeoutMs?: number | undefined
  /** The most contexts held at once (default `HeraCache.DEFAULT_MAX_ENTRIES`). */
  readonly maxContexts?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}
