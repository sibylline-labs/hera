import type { HeraTelemetrySink } from "../../../core/telemetry/types.js"

/**
 * Why a batch did or did not leave: every outcome is one closed literal, never a body or error text.
 * `overflowed`: every GenAI span of the flush was dropped for a full buffer, so nothing was posted.
 */
export type HeraExportOutcome = "sent" | "unconfigured" | "rejected" | "unreachable" | "unserializable" | "overflowed"

export interface HeraExportReport {
  readonly outcome: HeraExportOutcome
  /** Spans in the batch. */
  readonly spans: number
  /** Spans dropped for a full buffer since the last report. */
  readonly dropped: number
}

/**
 * Where spans go: core's sink. Both fields are required together: a token with no URL (or the
 * reverse) is refused as `unconfigured`, never sent to a default host.
 */
export type HeraAgentTelemetrySink = HeraTelemetrySink

export interface HeraAgentTelemetryOptions {
  /** `service.name`. */
  readonly service: string
  /** `deployment.environment.name` (`"prod"`, `"local"`): required, so Logfire never reads it as null. */
  readonly environment: string
  /** `service.version`, e.g. `env.CF_VERSION_METADATA?.id`. */
  readonly version?: string | undefined
  /** Stamped as `hera.tenant` and prefixed onto `gen_ai.conversation.id`. */
  readonly tenant: string
  readonly sink: HeraAgentTelemetrySink
  /** The Durable Object's `ctx.waitUntil`, so an export outlives the request that ended the span. */
  readonly waitUntil: (promise: Promise<unknown>) => void
  /** Whether content attributes may leave. Default `false`; the caller decides per org from `HeraFlags`. */
  readonly contentExport?: boolean | undefined
  /** Spans exported per flush; the rest are dropped and counted. Default 256. */
  readonly maxBufferedSpans?: number | undefined
  /** Whole-exchange timeout per POST. Default core's `5000` ms. */
  readonly timeoutMs?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly onExport?: ((report: HeraExportReport) => void) | undefined
}

export const DEFAULT_MAX_BUFFERED_SPANS = 256
