import * as Option from "effect/Option"
import type * as Tracer from "effect/Tracer"
import { scrubLogString } from "../logger/redaction.js"
import type { ScrubRules } from "../logger/types.js"
import { type OtlpKeyValue, toAttributes } from "./otlp-values.js"
import type { CapturedSpan, DescribedException } from "./types.js"

const KIND: Readonly<Record<Tracer.SpanKind, number>> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
}

const STATUS_UNSET = 0
const STATUS_ERROR = 2
const MAX_EVENTS = 32

type SpanEvent = readonly [name: string, startTime: bigint, attributes: Record<string, unknown>]

/** Events a native span recorded through `Tracer.Span.event`; read structurally, capped. */
function recordedEvents(span: Tracer.Span): ReadonlyArray<SpanEvent> {
  const events: unknown = Reflect.get(span, "_events")
  return Array.isArray(events) ? (events as ReadonlyArray<SpanEvent>).slice(0, MAX_EVENTS) : []
}

function exceptionEvent(exception: DescribedException, endNs: bigint): unknown {
  return {
    name: "exception",
    timeUnixNano: endNs.toString(),
    attributes: [
      { key: "exception.type", value: { stringValue: exception.type } },
      { key: "exception.message", value: { stringValue: exception.message } },
      { key: "exception.stacktrace", value: { stringValue: exception.stacktrace } },
    ],
  }
}

function toOtlpSpan(captured: CapturedSpan, rules: ScrubRules, parents: ReadonlySet<string>): unknown {
  const { span, endNs, exception } = captured
  const parentSpanId = Option.isSome(span.parent) ? span.parent.value.spanId : undefined
  const extra: Record<string, unknown> = {
    ...(captured.errorCode !== undefined ? { "error.code": captured.errorCode } : {}),
    ...(exception !== undefined ? { "logfire.exception.fingerprint": exception.fingerprint } : {}),
  }
  const events = recordedEvents(span).map(([name, time, attributes]) => ({
    name: scrubLogString(name, rules),
    timeUnixNano: time.toString(),
    attributes: toAttributes(attributes, rules),
  }))
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(parentSpanId !== undefined && parents.has(parentSpanId) ? { parentSpanId } : {}),
    name: scrubLogString(span.name, rules),
    kind: KIND[span.kind] ?? KIND.internal,
    startTimeUnixNano: span.status.startTime.toString(),
    endTimeUnixNano: endNs.toString(),
    attributes: [...toAttributes(span.attributes, rules), ...toAttributes(extra, rules)],
    events: exception !== undefined ? [...events, exceptionEvent(exception, endNs)] : events,
    links: span.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: toAttributes(link.attributes, rules),
    })),
    status: captured.errored
      ? { code: STATUS_ERROR, message: exception?.type ?? "Error" }
      : { code: STATUS_UNSET },
  }
}

/**
 * An OTLP/JSON `ExportTraceServiceRequest` for `spans`. A span's `parentSpanId` is sent only when it is
 * in `parents` (the ids the export may name, from `exportedParentIds`); otherwise the span is a root.
 */
export function buildTraceRequest(
  resource: ReadonlyArray<OtlpKeyValue>,
  spans: ReadonlyArray<CapturedSpan>,
  rules: ScrubRules,
  parents: ReadonlySet<string>
): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [{ scope: { name: "@sibylline-labs/hera" }, spans: spans.map((span) => toOtlpSpan(span, rules, parents)) }],
      },
    ],
  }
}
