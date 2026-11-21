import { RequestId } from "../../core/schema/index.js"
import { parseTraceparent } from "../rpc/trace-context.js"

/** The key a traced outbox queue body carries its trace context under. */
export const HERA_TRACE_ENVELOPE_KEY = "__heraTrace"

/** A traced queue body: the record's payload beside the producer's trace context. */
export interface HeraTraceEnvelope {
  readonly __heraTrace: {
    readonly v: 1
    readonly traceparent?: string
    readonly requestId?: string
  }
  readonly payload: unknown
}

/**
 * Wraps `payload` with the producer's trace context. A record with neither value goes bare, so a
 * consumer never sees an envelope that carries nothing.
 */
export function wrapTraceEnvelope(record: {
  readonly payload: unknown
  readonly traceparent?: string | undefined
  readonly requestId: string | null
}): unknown {
  if (record.traceparent === undefined && record.requestId === null) {
    return record.payload
  }
  const envelope: HeraTraceEnvelope = {
    __heraTrace: {
      v: 1,
      ...(record.traceparent !== undefined ? { traceparent: record.traceparent } : {}),
      ...(record.requestId !== null ? { requestId: record.requestId } : {}),
    },
    payload: record.payload,
  }
  return envelope
}

/**
 * The body a consumer decodes and the trace context beside it. Anything that is not a well-formed
 * version-1 envelope is returned as the body untouched; a malformed `traceparent` or `requestId`
 * inside one is dropped.
 */
export function unwrapTraceEnvelope(body: unknown): {
  readonly body: unknown
  readonly traceparent?: string
  readonly requestId?: string
} {
  if (typeof body !== "object" || body === null || !(HERA_TRACE_ENVELOPE_KEY in body) || !("payload" in body)) {
    return { body }
  }
  const trace = (body as Record<string, unknown>)[HERA_TRACE_ENVELOPE_KEY]
  if (typeof trace !== "object" || trace === null || (trace as { readonly v?: unknown }).v !== 1) {
    return { body }
  }
  const { traceparent, requestId } = trace as { readonly traceparent?: unknown; readonly requestId?: unknown }
  return {
    body: (body as { readonly payload: unknown }).payload,
    ...(parseTraceparent(traceparent) !== undefined ? { traceparent: traceparent as string } : {}),
    ...(RequestId.is(requestId) ? { requestId } : {}),
  }
}
