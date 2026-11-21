import type { ResolvedTelemetryConfig } from "../../../core/telemetry/config.js"
import { type OtlpKeyValue, toAttributes, unixNano } from "../../../core/telemetry/otlp-values.js"
import type { DescribedException } from "../../../core/telemetry/types.js"
import { isContentKey } from "./content-keys.js"
import type { AgentAttributes, AgentSpanStatus, EndedSpan } from "./span.js"

const SPAN_KIND_INTERNAL = 1
const STATUS_CODE: Readonly<Record<AgentSpanStatus, number>> = { unset: 0, ok: 1, error: 2 }
const SCOPE = { name: "@sibylline-labs/hera/agent" }

/**
 * Attributes as OTLP key-values. Everything goes through core's encoder (scrubbed again, bounded),
 * except content: the pipeline already cut it run-by-run, and a message must leave whole or not at all.
 */
function attributesOf(attributes: AgentAttributes, rules: ResolvedTelemetryConfig["rules"]): OtlpKeyValue[] {
  const metadata: Record<string, unknown> = {}
  const content: OtlpKeyValue[] = []
  for (const [key, value] of Object.entries(attributes)) {
    if (!isContentKey(key)) {
      metadata[key] = value
    } else if (typeof value === "string") {
      content.push({ key, value: { stringValue: value } })
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      const values = (value as ReadonlyArray<string>).map((item) => ({ stringValue: item }))
      content.push({ key, value: { arrayValue: { values } } })
    }
  }
  return [...toAttributes(metadata, rules), ...content]
}

function exceptionEvent(exception: DescribedException, endMs: number): unknown {
  return {
    name: "exception",
    timeUnixNano: unixNano(endMs),
    attributes: [
      { key: "exception.type", value: { stringValue: exception.type } },
      { key: "exception.message", value: { stringValue: exception.message } },
      { key: "exception.stacktrace", value: { stringValue: exception.stacktrace } },
    ],
  }
}

function toOtlpSpan(span: EndedSpan, rules: ResolvedTelemetryConfig["rules"]): unknown {
  const { exception } = span
  const extra: Record<string, unknown> = exception === undefined ? {} : { "logfire.exception.fingerprint": exception.fingerprint }
  const events = span.events.map((event) => ({
    name: event.name,
    timeUnixNano: unixNano(event.timeMs),
    attributes: attributesOf(event.attributes, rules),
  }))
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: unixNano(span.startMs),
    endTimeUnixNano: unixNano(span.endMs),
    attributes: [...attributesOf(span.attributes, rules), ...toAttributes(extra, rules)],
    events: exception === undefined ? events : [...events, exceptionEvent(exception, span.endMs)],
    ...(span.droppedEvents > 0 ? { droppedEventsCount: span.droppedEvents } : {}),
    links: span.links.map((link) => ({
      traceId: link.traceId,
      spanId: link.spanId,
      attributes: attributesOf(link.attributes, rules),
    })),
    status:
      span.status === "error"
        ? { code: STATUS_CODE.error, message: exception?.type ?? "Error" }
        : { code: STATUS_CODE[span.status] },
  }
}

/** An OTLP/JSON `ExportTraceServiceRequest` for already-scrubbed `spans`, under core's resource. */
export function buildAgentTraceRequest(config: ResolvedTelemetryConfig, spans: ReadonlyArray<EndedSpan>): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: toAttributes(config.resource, config.rules) },
        scopeSpans: [{ scope: SCOPE, spans: spans.map((span) => toOtlpSpan(span, config.rules)) }],
      },
    ],
  })
}
