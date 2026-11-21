import type * as Tracer from "effect/Tracer"
import { parseTraceparent } from "./traceparent.js"
import type { HeraTelemetrySource } from "./types.js"

export interface ResolvedTraceContext {
  /** The remote parent the invocation's root span runs under; absent for a fresh root. */
  readonly parent: Tracer.ExternalSpan | undefined
  readonly sampled: boolean
}

/**
 * The one funnel an invocation's trace context comes from. `"external"` never
 * reads the caller's `traceparent`, so a public caller can neither pick the trace id nor force
 * `sampled=1`; the root is head-sampled at `headRate`. `"internal"` (a trusted binding) parents
 * under a valid `traceparent` and follows its sampled flag; without one it is a fresh root.
 */
export function resolveTraceContext(options: {
  readonly source: HeraTelemetrySource
  readonly traceparent: string | undefined
  readonly headRate: number
  readonly random: () => number
}): ResolvedTraceContext {
  const parent = options.source === "internal" ? parseTraceparent(options.traceparent) : undefined
  if (parent !== undefined) {
    return { parent, sampled: parent.sampled }
  }
  return { parent: undefined, sampled: options.random() < options.headRate }
}
