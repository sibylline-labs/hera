import type { Api, AssistantMessage, Model, ToolCall, TranscriptContext } from "@earendil-works/pi-ai"
import type { SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai"
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream"
import type { HeraAgentUpstream } from "../../server/agent/egress/egress.js"

/** Token counts a scripted reply reports, as Gemini's `usageMetadata` would. */
export interface ScriptedUsage {
  readonly promptTokens: number
  readonly candidatesTokens: number
  readonly thoughtsTokens?: number | undefined
}

interface StepBase {
  readonly usage?: ScriptedUsage | undefined
  /** The `cf-aig-log-id` the reply carries; default a fresh id per request (a re-issue is a new request). */
  readonly logId?: string | undefined
  /** Milliseconds before the reply completes; an abort in the window ends it `aborted`. */
  readonly delayMs?: number | undefined
}

export type HeraAgentScriptStep =
  | (StepBase & { readonly kind: "toolCall"; readonly calls: ReadonlyArray<{ readonly name: string; readonly args: unknown }> })
  | (StepBase & { readonly kind: "text"; readonly text: string })
  | (StepBase & { readonly kind: "fail"; readonly message: string })

const DEFAULT_USAGE: ScriptedUsage = { promptTokens: 10, candidatesTokens: 5 }

/**
 * A step is chosen by how many assistant replies the request's transcript already holds, so a
 * script is stateless: a request re-issued after an eviction gets the same step, and the same call
 * ids (`call_<step>_<n>`), as Pi's replay expects.
 */
function stepIndex(context: TranscriptContext): number {
  return context.messages.filter((m) => m.role === "assistant").length
}

function message(model: Model<Api>, step: HeraAgentScriptStep, index: number): AssistantMessage {
  const usage = step.usage ?? DEFAULT_USAGE
  const thoughts = usage.thoughtsTokens ?? 0
  const content: AssistantMessage["content"] =
    step.kind === "text"
      ? [{ type: "text", text: step.text }]
      : step.kind === "toolCall"
        ? step.calls.map(
            (call, n): ToolCall => ({
              type: "toolCall",
              id: `call_${index}_${n}`,
              name: call.name,
              arguments: call.args as ToolCall["arguments"],
            })
          )
        : []
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: usage.promptTokens,
      output: usage.candidatesTokens + thoughts,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.promptTokens + usage.candidatesTokens + thoughts,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: step.kind === "fail" ? "error" : step.kind === "toolCall" ? "toolUse" : "stop",
    ...(step.kind === "fail" ? { errorMessage: step.message } : {}),
    timestamp: Date.now(),
  }
}

/** The raw Gemini-shaped chunk the egress meter reads (`usageMetadata` + gateway log id header). */
function providerChunk(step: HeraAgentScriptStep): unknown {
  const usage = step.usage ?? DEFAULT_USAGE
  const thoughts = usage.thoughtsTokens ?? 0
  return {
    usageMetadata: {
      promptTokenCount: usage.promptTokens,
      candidatesTokenCount: usage.candidatesTokens,
      thoughtsTokenCount: thoughts,
      totalTokenCount: usage.promptTokens + usage.candidatesTokens + thoughts,
    },
    sdkHttpResponse: { headers: { "cf-aig-log-id": step.logId ?? `scripted-${crypto.randomUUID()}` } },
  }
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const timer = setTimeout(() => resolve(true), ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

function reply(
  steps: ReadonlyArray<HeraAgentScriptStep>,
  model: Model<Api>,
  context: TranscriptContext,
  options: StreamOptions | SimpleStreamOptions | undefined
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const index = stepIndex(context)
  const step: HeraAgentScriptStep = steps[index] ?? { kind: "fail", message: `script exhausted at step ${index}` }
  void (async () => {
    const final = message(model, step, index)
    stream.push({ type: "start", partial: { ...final, content: [] } })
    if (!(await wait(step.delayMs ?? 0, options?.signal))) {
      const aborted = { ...final, content: [], stopReason: "aborted" as const }
      stream.push({ type: "error", reason: "aborted", error: aborted })
      return stream.end(aborted)
    }
    if (step.kind !== "fail") await options?.onProviderStreamEvent?.(providerChunk(step), model)
    if (step.kind === "fail") {
      stream.push({ type: "error", reason: "error", error: final })
      return stream.end(final)
    }
    final.content.forEach((block, contentIndex) => {
      if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex, partial: final })
        stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: final })
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: final })
      } else if (block.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: final })
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: final })
      }
    })
    stream.push({ type: "done", reason: step.kind === "toolCall" ? "toolUse" : "stop", message: final })
    stream.end(final)
  })()
  return stream
}

/** A scripted model upstream: each request answers the next step of `steps`. */
export function scriptedUpstream(steps: ReadonlyArray<HeraAgentScriptStep>): HeraAgentUpstream {
  const run = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions | SimpleStreamOptions) =>
    reply(steps, model, context, options)
  return { stream: run, streamSimple: run }
}
