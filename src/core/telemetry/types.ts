import type * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import type * as Tracer from "effect/Tracer"
import type { ErrorMessageMode, RedactionRules } from "../logger/types.js"

/** Where exports go. A token needs its `baseUrl`: Hera never sends one to a default host. */
export interface HeraTelemetrySink {
  /** The Logfire base URL (`LOGFIRE_BASE_URL`); records post to `${baseUrl}/v1/traces` and `/v1/logs`. */
  readonly baseUrl?: string | undefined
  /** The project write token, sent as the `authorization` value. Unset: nothing exports. */
  readonly token?: Redacted.Redacted<string> | undefined
}

export interface HeraTelemetrySampling {
  /** Head-sampling rate for a root invocation (`source: "external"` or no parent). Default `0.01`. */
  readonly headRate?: number | undefined
  /** An invocation longer than this promotes its buffer. Default `1000` ms. */
  readonly slowThresholdMs?: number | undefined
  /** Finished spans held per invocation; the oldest is overwritten past it. Default `48`. */
  readonly maxBufferedSpans?: number | undefined
  /** `info` records held per invocation, and the cap on `warn`/`error` records. Default `32`. */
  readonly maxBufferedLogs?: number | undefined
}

export interface HeraTelemetryConfig {
  /** `service.name`; never empty. */
  readonly service: string
  /** `deployment.environment.name` (`"prod"`, `"local"`). */
  readonly environment: string
  /** `service.version`, e.g. `env.CF_VERSION_METADATA?.id`. */
  readonly version?: string | undefined
  readonly sink: HeraTelemetrySink
  readonly sampling?: HeraTelemetrySampling | undefined
  readonly redaction?: {
    readonly rules?: RedactionRules | undefined
    /** `"scrubbed"` exports a scrubbed `exception.message`; default `"redacted"`. Stack line 1 is always redacted. */
    readonly errorMessages?: ErrorMessageMode | undefined
  } | undefined
  /** Whole-exchange timeout per POST. Default `5000` ms. */
  readonly timeoutMs?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  /** Clock and sampling source; injected by tests. */
  readonly now?: (() => number) | undefined
  readonly random?: (() => number) | undefined
  /** Called once per POST with its closed outcome; never with a body or error text. */
  readonly onExport?: ((report: HeraTelemetryExportReport) => void) | undefined
}

/** `"external"`: public ingress, the caller's `traceparent` is ignored. `"internal"`: a trusted binding. */
export type HeraTelemetrySource = "external" | "internal"

export interface HeraTelemetryBeginOptions {
  readonly name: string
  readonly source: HeraTelemetrySource
  /** The inbound W3C `traceparent`; read only for `source: "internal"`. */
  readonly traceparent?: string | undefined
  /** The invocation's `ExecutionContext.waitUntil` / `DurableObjectState.waitUntil`. */
  readonly waitUntil: (promise: Promise<unknown>) => void
}

/** How an invocation ended. Any of these, or a slow run, promotes the buffer. */
export interface HeraTelemetryEnd {
  readonly status?: number | undefined
  readonly defect?: boolean | undefined
}

export interface HeraTelemetryInvocation {
  /** Whether the root was head-sampled (or the trusted parent was). */
  readonly sampled: boolean
  /** Runs `effect` under this invocation's tracer, loggers and log capture. */
  readonly provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Decides promotion and hands the export to `waitUntil`. A second call does nothing. */
  readonly end: (outcome?: HeraTelemetryEnd) => void
}

export interface HeraTelemetry {
  readonly service: string
  /** True when a token and its `baseUrl` are set. */
  readonly configured: boolean
  readonly begin: (options: HeraTelemetryBeginOptions) => HeraTelemetryInvocation
}

/** What a boundary takes: the isolate's telemetry and the invocation's `waitUntil`. */
export interface HeraTelemetryHook {
  readonly telemetry: HeraTelemetry
  readonly waitUntil: (promise: Promise<unknown>) => void
}

export type HeraTelemetryExportOutcome = "sent" | "rejected" | "unreachable"

export interface HeraTelemetryExportReport {
  readonly signal: "traces" | "logs"
  readonly outcome: HeraTelemetryExportOutcome
  readonly records: number
  /** Records the rings overwrote or the warn/error cap refused. */
  readonly dropped: number
  readonly promoted: boolean
}

export type HeraTelemetryLevel = "debug" | "info" | "warn" | "error"

/** One finished log record, already scrubbed by whoever captured it. */
export interface CapturedLogRecord {
  readonly timeMs: number
  readonly level: HeraTelemetryLevel
  readonly body: string
  readonly attributes: Readonly<Record<string, unknown>>
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
}

/** The exception a failed span exports; built only by `describeFailure`, so the stack is always scrubbed. */
export interface DescribedException {
  readonly type: string
  readonly message: string
  readonly stacktrace: string
  readonly fingerprint: string
  readonly code?: string | undefined
}

/** A finished span as the exporter reads it. */
export interface CapturedSpan {
  readonly span: Tracer.Span
  readonly endNs: bigint
  readonly errored: boolean
  readonly exception?: DescribedException | undefined
  readonly errorCode?: string | undefined
  readonly errorFields?: Readonly<Record<string, string | number | boolean>> | undefined
}

export const DEFAULT_HEAD_RATE = 0.01
export const DEFAULT_SLOW_THRESHOLD_MS = 1_000
export const DEFAULT_MAX_BUFFERED_SPANS = 48
export const DEFAULT_MAX_BUFFERED_LOGS = 32
export const DEFAULT_TELEMETRY_TIMEOUT_MS = 5_000
export const MAX_STACK_FRAMES = 50
