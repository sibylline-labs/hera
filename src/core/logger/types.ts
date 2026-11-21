import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { ActorId, OrgId, RequestId } from "../schema/index.js"

export type HeraErrorTag =
  | "HeraError"
  | "HeraConfigError"
  | "HeraSchemaError"
  | "HeraAuthError"
  | "HeraValidationError"
  | "HeraNotFoundError"
  | "HeraConflictError"
  | "HeraRateLimitError"
  | "HeraInfraError"

export const REDACTED_VALUE = "[REDACTED]" as const
export const TRUNCATED_VALUE = "[TRUNCATED]" as const
export const CIRCULAR_VALUE = "[CIRCULAR]" as const

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEntry {
  readonly timestamp: string
  readonly level: LogLevel
  readonly service: string
  readonly msg: string
  readonly request_id: string | null
  readonly org_id: string | null
  readonly actor_id: string | null
  readonly span: string | null
  /** The Hera ctx's actor kind, written only when the fiber carries one. */
  readonly actor_kind?: string
  /** The active span's W3C trace id (32 hex), written only inside a span. */
  readonly trace_id?: string
  /** The active span's W3C span id (16 hex), written only inside a span. */
  readonly span_id?: string
  readonly [key: string]: unknown
}

export type LogSink = (line: string, entry: LogEntry) => void

export interface ScrubbedError {
  readonly _tag?: string
  readonly name: string
  readonly code: string
  readonly message: string
  readonly status?: number
  readonly retryAfterSeconds?: number
  readonly cause?: unknown
}

/**
 * What an error-like field writes as its `message`. `"redacted"` (the default) writes `[REDACTED]`
 * unless the error's code is whitelisted. `"scrubbed"` writes every message, and a string `cause`,
 * after the logger's value-shape redaction and then cut to {@link ERROR_MESSAGE_LIMIT}: scrubbing
 * first, so a credential the cut would split is already whole-redacted. Shape rules see
 * credential shapes only, so a secret in free prose (`password is xyz`) is written in this mode.
 */
export type ErrorMessageMode = "redacted" | "scrubbed"

/** The longest `message` an error-like field writes, counted after scrubbing. */
export const ERROR_MESSAGE_LIMIT = 300

export interface ScrubOptions {
  readonly whitelistedErrorCodes?:
    | ReadonlySet<string>
    | ReadonlyArray<string>
    | undefined
  readonly errorMessages?: ErrorMessageMode | undefined
}

/**
 * A consumer's own redaction rules, applied as a union with Hera's: they can only redact more.
 * `secretKeys` names credential keys Hera's list does not; `secretShapes` are credential runs a
 * consumer mints (replaced in place, wherever they sit in a string or key).
 */
export interface RedactionRules {
  readonly secretKeys?: RegExp | undefined
  readonly secretShapes?: ReadonlyArray<RegExp> | undefined
}

/** The rule set the scrubber threads: the consumer's {@link RedactionRules} and its error-message mode. */
export interface ScrubRules extends RedactionRules {
  readonly errorMessages?: ErrorMessageMode | undefined
}

export interface CreateHeraLoggerOptions {
  readonly service: string
  readonly requestId?: RequestId | string | null | undefined
  readonly orgId?: OrgId | string | null | undefined
  readonly actorId?: ActorId | string | null | undefined
  readonly span?: string | null | undefined
  readonly fields?: Readonly<Record<string, unknown>> | undefined
  readonly whitelistedErrorCodes?:
    | ReadonlySet<string>
    | ReadonlyArray<string>
    | undefined
  readonly sink?: LogSink | undefined
  /**
   * Keep writing to `sink` while an exporting telemetry invocation also takes the line. Default
   * `false`: a captured line ships once, through the invocation's OTLP export.
   */
  readonly teeSinkWhenCaptured?: boolean | undefined
  /** Extra credential key names, unioned with Hera's (`RedactionRules.secretKeys`). */
  readonly secretKeys?: RegExp | undefined
  /** Extra credential-shaped runs, unioned with Hera's (`RedactionRules.secretShapes`). */
  readonly secretShapes?: ReadonlyArray<RegExp> | undefined
  /** `"scrubbed"` writes error messages scrubbed then bounded; default `"redacted"` ({@link ErrorMessageMode}). */
  readonly errorMessages?: ErrorMessageMode | undefined
}

export interface HeraLogger {
  readonly debug: (
    msg: string,
    metadata?: Readonly<Record<string, unknown>>
  ) => Effect.Effect<void>
  readonly info: (
    msg: string,
    metadata?: Readonly<Record<string, unknown>>
  ) => Effect.Effect<void>
  readonly warn: (
    msg: string,
    metadata?: Readonly<Record<string, unknown>>
  ) => Effect.Effect<void>
  readonly error: (
    msg: string,
    metadata?: Readonly<Record<string, unknown>>
  ) => Effect.Effect<void>
  readonly child: (fields: Readonly<Record<string, unknown>>) => HeraLogger
  readonly layer: Layer.Layer<HeraLoggerService>
}

export class HeraLoggerService extends Context.Service<
  HeraLoggerService,
  HeraLogger
>()("hera/HeraLoggerService") {}

/**
 * Ambient fiber reference carrying correlation fields bound via `logger.child(fields).layer`.
 */
export const CurrentLogCorrelation = Context.Reference<
  Readonly<Record<string, unknown>>
>("hera/CurrentLogCorrelation", {
  defaultValue: () => ({}),
})

export interface InternalLoggerState {
  readonly service: string
  readonly requestId: string | null
  readonly orgId: string | null
  readonly actorId: string | null
  readonly span: string | null
  readonly boundFields: Readonly<Record<string, unknown>>
  readonly whitelist: ReadonlySet<string>
  readonly sink: LogSink
  /** Write to `sink` even when an exporting invocation captured the line. */
  readonly teeSinkWhenCaptured: boolean
  readonly rules: ScrubRules
  /** Written after per-call fields, so no call can spoof them (an event logger's bound fields). */
  readonly pinnedFields: Readonly<Record<string, unknown>>
}

export const MAX_SCRUB_DEPTH = 8

export const RESERVED_LOG_KEYS = new Set([
  "timestamp",
  "level",
  "service",
  "msg",
  "request_id",
  "org_id",
  "actor_id",
  "span",
  "actor_kind",
  "trace_id",
  "span_id",
])

export const HERA_ERROR_TAGS: ReadonlySet<HeraErrorTag> = new Set<HeraErrorTag>(
  [
    "HeraError",
    "HeraConfigError",
    "HeraSchemaError",
    "HeraAuthError",
    "HeraValidationError",
    "HeraNotFoundError",
    "HeraConflictError",
    "HeraRateLimitError",
    "HeraInfraError",
  ]
)

export const DEFAULT_ERROR_CODES: Readonly<Record<HeraErrorTag, string>> = {
  HeraError: "internal_error",
  HeraConfigError: "hera_config_error",
  HeraSchemaError: "invalid_request",
  HeraAuthError: "hera_auth_error",
  HeraValidationError: "hera_validation_error",
  HeraNotFoundError: "hera_not_found_error",
  HeraConflictError: "hera_conflict_error",
  HeraRateLimitError: "hera_rate_limit_error",
  HeraInfraError: "hera_infra_error",
}
