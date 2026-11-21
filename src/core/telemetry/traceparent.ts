import * as Context from "effect/Context"
import type * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import { CurrentTelemetryCapture } from "./capture.js"

/** W3C trace-context version 00: `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`. */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const ALL_ZERO = /^0+$/
const TRACE_ID = /^[0-9a-f]{32}$/
const SPAN_ID = /^[0-9a-f]{16}$/

/** The `traceparent` of `span`, or `undefined` when its ids are not W3C-shaped. */
export function formatTraceparent(span: Tracer.AnySpan, sampled: boolean = span.sampled): string | undefined {
  if (!TRACE_ID.test(span.traceId) || !SPAN_ID.test(span.spanId)) {
    return undefined
  }
  if (ALL_ZERO.test(span.traceId) || ALL_ZERO.test(span.spanId)) {
    return undefined
  }
  return `00-${span.traceId}-${span.spanId}-${sampled ? "01" : "00"}`
}

/**
 * The `traceparent` of the fiber's current span, for a call or an event leaving the fiber. It says
 * sampled only when something exports that span: a span of a capturing invocation that sampled it,
 * or a remote parent its caller sampled. Effect's default tracer marks every span sampled, and a
 * callee told `01` exports a child of a span nobody sends.
 */
export function ambientTraceparent(fiber: Fiber.Fiber<unknown, unknown>): string | undefined {
  const span = Context.getOption(fiber.context, Tracer.ParentSpan)
  if (Option.isNone(span)) return undefined
  const exported =
    span.value._tag === "ExternalSpan"
      ? span.value.sampled
      : fiber.getRef(CurrentTelemetryCapture) !== undefined && span.value.sampled
  return formatTraceparent(span.value, exported)
}

/**
 * The remote span a `traceparent` names, or `undefined` for anything else: a non-string, the
 * wrong shape, version `ff`, or an all-zero id. The caller then starts a fresh root.
 */
export function parseTraceparent(value: unknown): Tracer.ExternalSpan | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const match = TRACEPARENT.exec(value)
  if (match === null) {
    return undefined
  }
  const [, version, traceId, spanId, flags] = match as unknown as [string, string, string, string, string]
  if (version === "ff" || ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) {
    return undefined
  }
  return Tracer.externalSpan({
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & 1) === 1,
  })
}
