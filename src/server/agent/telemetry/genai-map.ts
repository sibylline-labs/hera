import type { SpanAttributes } from "@earendil-works/pi-telemetry"

const CHAT_SPANS: ReadonlySet<string> = new Set(["pi.ai.request", "pi.ai.poll"])
export const PHASE_SPAN = "pi.durable.phase"

export function isChatSpan(piName: string): boolean {
  return CHAT_SPANS.has(piName)
}

/**
 * Whether a Pi span may export: a model request is GenAI from its start, and a task phase becomes
 * `execute_tool` when it calls a tool. Every other Pi span (a submission, a task) is always dropped.
 */
export function mayBeGenAi(piName: string): boolean {
  return isChatSpan(piName) || piName === PHASE_SPAN
}

/** Pi's start name and attributes onto the GenAI conventions; Pi's own names stay under `pi.*`. */
export function genAiStart(piName: string, attributes: SpanAttributes): { name: string; attributes: SpanAttributes } {
  if (!isChatSpan(piName)) return { name: piName, attributes: { ...attributes } }
  return {
    name: `chat ${String(attributes["model"])}`,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.system": attributes["provider"],
      "gen_ai.provider.name": attributes["provider"],
      "gen_ai.request.model": attributes["model"],
      "pi.api": attributes["api"],
    },
  }
}

/** Pi's end attributes for a model request: usage, cost and finish reason. */
export function genAiEnd(piName: string, attributes: SpanAttributes): SpanAttributes {
  if (!isChatSpan(piName)) return attributes
  const input = Number(attributes["usage.input"] ?? 0)
  const cacheRead = Number(attributes["usage.cache_read"] ?? 0)
  const cacheWrite = Number(attributes["usage.cache_write"] ?? 0)
  const stop = attributes["stop"]
  return {
    "gen_ai.usage.input_tokens": input + cacheRead + cacheWrite,
    "gen_ai.usage.output_tokens": attributes["usage.output"],
    "gen_ai.usage.cache_read.input_tokens": cacheRead || undefined,
    "gen_ai.usage.cache_write.input_tokens": cacheWrite || undefined,
    "gen_ai.response.id": attributes["response.id"],
    "gen_ai.response.finish_reasons": stop === undefined ? undefined : [String(stop)],
    "operation.cost": attributes["cost.total"],
  }
}

/** A task phase that called a tool is an `execute_tool` span; the tool is known only at end. */
export function toolPhase(attributes: SpanAttributes): { name: string; attributes: SpanAttributes } | undefined {
  const tool = attributes["tool.name"]
  if (typeof tool !== "string") return undefined
  return {
    name: `execute_tool ${tool}`,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": tool,
      "gen_ai.tool.call.id": attributes["tool.call_id"],
    },
  }
}
