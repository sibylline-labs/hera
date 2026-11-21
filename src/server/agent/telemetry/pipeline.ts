import type { ResolvedTelemetryConfig } from "../../../core/telemetry/config.js"
import { postOtlp } from "../../../core/telemetry/export.js"
import { isGenAiSpan, isInvokeAgent, keepGenAi } from "./genai-filter.js"
import { buildAgentTraceRequest } from "./otlp.js"
import { redactSpan } from "./scrub-span.js"
import type { EndedSpan } from "./span.js"
import type { HeraExportOutcome, HeraExportReport } from "./types.js"

export interface PipelineOptions {
  /** The export target; `undefined` when the sink lacks its URL or its token (nothing is sent). */
  readonly config: ResolvedTelemetryConfig | undefined
  readonly contentExport: boolean
  readonly waitUntil: (promise: Promise<unknown>) => void
  readonly maxBufferedSpans: number
  readonly onExport?: ((report: HeraExportReport) => void) | undefined
}

export interface Pipeline {
  /** Registers a span as it opens, so a child that ends first can wait to learn whether it exports. */
  readonly start: (spanId: string) => void
  /** Takes a span the moment it ends: scrubbed here, first, so nothing downstream sees a raw value. */
  readonly end: (span: EndedSpan) => void
  /** Exports what has ended. Never rejects. */
  readonly flush: () => Promise<void>
}

/**
 * Scrub on end, hold until flush, keep the GenAI spans (re-parented past dropped ones), cap, encode
 * and post. `invoke_agent` ending is a flush, handed to `waitUntil` so it outlives the request.
 * Every outcome is one closed literal; no failure reaches the agent.
 */
export function makePipeline(options: PipelineOptions): Pipeline {
  const cap = options.maxBufferedSpans
  const state: { ended: EndedSpan[]; refused: number } = { ended: [], refused: 0 }
  const open = new Set<string>()
  // Bounded: the oldest are forgotten first; a child that outlives that many drops keeps its pointer.
  const droppedIds = new Map<string, string | undefined>()
  const forget = (span: EndedSpan) => {
    droppedIds.set(span.spanId, span.parentSpanId)
    if (droppedIds.size > cap * 4) droppedIds.delete(droppedIds.keys().next().value as string)
  }

  const report = (outcome: HeraExportOutcome, spans: number, dropped: number) => {
    try {
      const returned: unknown = options.onExport?.({ outcome, spans, dropped })
      // An async reporter's rejection is contained too.
      if (returned instanceof Promise) returned.catch(() => undefined)
    } catch {
      // A reporter's failure is not the agent's.
    }
  }

  const flush = async (): Promise<void> => {
    // Swap before awaiting: a flush started meanwhile finds the buffer empty.
    const batch = state.ended
    const refused = state.refused
    state.refused = 0
    const { kept, held } = keepGenAi(batch, { open, dropped: droppedIds })
    // Held spans go back before any await, so a flush that runs meanwhile neither loses nor resends them.
    state.ended = held
    for (const span of batch) if (!isGenAiSpan(span)) forget(span)
    if (kept.length === 0 && refused === 0) return
    const spans = kept.slice(0, cap)
    const dropped = kept.length - spans.length + refused
    const config = options.config
    if (spans.length === 0) {
      // Only refused spans: nothing to post, but the loss is still reported.
      report(config === undefined ? "unconfigured" : "overflowed", 0, dropped)
      return
    }
    if (config === undefined) {
      report("unconfigured", spans.length, dropped)
      return
    }
    let body: string
    try {
      body = buildAgentTraceRequest(config, spans)
    } catch {
      report("unserializable", spans.length, dropped)
      return
    }
    report(await postOtlp(config, "traces", body), spans.length, dropped)
  }

  return {
    start(spanId) {
      open.add(spanId)
    },
    end(span) {
      open.delete(span.spanId)
      // Bounded too: the newest beyond twice the export cap are refused, and a refused GenAI span counts as dropped.
      if (state.ended.length < cap * 2) state.ended.push(redactSpan(span, options.contentExport))
      else if (isGenAiSpan(span)) state.refused += 1
      if (isInvokeAgent(span)) options.waitUntil(flush())
    },
    flush,
  }
}
