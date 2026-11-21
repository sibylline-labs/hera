import type * as Redacted from "effect/Redacted"
import { HeraConfigError } from "../config/types.js"
import { GITLEAKS_SHAPES } from "../logger/gitleaks.js"
import type { ErrorMessageMode, ScrubRules } from "../logger/types.js"
import {
  DEFAULT_HEAD_RATE,
  DEFAULT_MAX_BUFFERED_LOGS,
  DEFAULT_MAX_BUFFERED_SPANS,
  DEFAULT_SLOW_THRESHOLD_MS,
  DEFAULT_TELEMETRY_TIMEOUT_MS,
  type HeraTelemetryConfig,
  type HeraTelemetryExportReport,
} from "./types.js"

/** A config with every default applied; read by the invocation, never by consumers. */
export interface ResolvedTelemetryConfig {
  readonly service: string
  readonly resource: Readonly<Record<string, string>>
  /** Set only when both the token and its URL are: the export target. */
  readonly target: { readonly baseUrl: string; readonly token: Redacted.Redacted<string> } | undefined
  readonly headRate: number
  readonly slowThresholdMs: number
  readonly maxBufferedSpans: number
  readonly maxBufferedLogs: number
  /** Hera's rules plus `GITLEAKS_SHAPES` plus the consumer's, applied to every exported string. */
  readonly rules: ScrubRules
  readonly errorMessages: ErrorMessageMode
  readonly timeoutMs: number
  readonly fetch: typeof globalThis.fetch | undefined
  readonly now: () => number
  readonly random: () => number
  readonly onExport: (report: HeraTelemetryExportReport) => void
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback
}

function rate(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_HEAD_RATE
}

/**
 * Applies the defaults and refuses a token without its `baseUrl`: Hera never
 * sends a credential to a host it was not configured for. No token is not an error: the
 * invocation falls back to the logger's console sink.
 */
export function resolveTelemetryConfig(config: HeraTelemetryConfig): ResolvedTelemetryConfig {
  const service = config.service.trim()
  if (service === "") {
    throw new HeraConfigError({ status: "invalid", envKey: "service", reason: "HeraTelemetry needs a non-empty service name" })
  }
  const baseUrl = config.sink.baseUrl?.trim() ?? ""
  const token = config.sink.token
  if (token !== undefined && baseUrl === "") {
    throw new HeraConfigError({
      status: "invalid",
      envKey: "LOGFIRE_BASE_URL",
      reason: "HeraTelemetry has a token but no sink.baseUrl; refusing to send it to a default host",
    })
  }
  const consumer = config.redaction?.rules
  return {
    service,
    resource: {
      "service.name": service,
      "deployment.environment.name": config.environment,
      ...(config.version !== undefined && config.version !== "" ? { "service.version": config.version } : {}),
      "telemetry.sdk.name": "@sibylline-labs/hera",
      "telemetry.sdk.language": "javascript",
    },
    target: token !== undefined ? { baseUrl: baseUrl.replace(/\/+$/, ""), token } : undefined,
    headRate: rate(config.sampling?.headRate),
    slowThresholdMs: positiveInt(config.sampling?.slowThresholdMs, DEFAULT_SLOW_THRESHOLD_MS),
    maxBufferedSpans: positiveInt(config.sampling?.maxBufferedSpans, DEFAULT_MAX_BUFFERED_SPANS),
    maxBufferedLogs: positiveInt(config.sampling?.maxBufferedLogs, DEFAULT_MAX_BUFFERED_LOGS),
    rules: {
      ...(consumer?.secretKeys !== undefined ? { secretKeys: consumer.secretKeys } : {}),
      secretShapes: [...GITLEAKS_SHAPES, ...(consumer?.secretShapes ?? [])],
    },
    errorMessages: config.redaction?.errorMessages ?? "redacted",
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_TELEMETRY_TIMEOUT_MS),
    fetch: config.fetch,
    now: config.now ?? Date.now,
    random: config.random ?? Math.random,
    onExport: config.onExport ?? (() => undefined),
  }
}
