import type { SpanAttributes, TelemetryCarrier, TelemetryContext } from "@earendil-works/pi-telemetry"
import { type ResolvedTelemetryConfig, resolveTelemetryConfig } from "../../../core/telemetry/config.js"
import { GITLEAKS_SHAPES } from "../../../core/logger/gitleaks.js"
import { extractCarrier } from "./carrier.js"
import { capText } from "./genai-content.js"
import { makePiContext, toAttributes } from "./pi-adapter.js"
import { makePipeline, type Pipeline } from "./pipeline.js"
import { AgentSpan, type StartSpanOptions } from "./span.js"
import { DEFAULT_MAX_BUFFERED_SPANS, type HeraAgentTelemetryOptions } from "./types.js"
import type { ScrubRules } from "../../../core/logger/types.js"

/** One finished agent run, emitted by the host as the `invoke_agent` span Logfire's Agents view reads. */
export interface InvokeAgentInput {
  readonly agent: string
  readonly conversationId: string | number
  readonly model?: string | undefined
  readonly provider?: string | undefined
  readonly responseModel?: string | undefined
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | undefined
  /** Content: exported only for `contentExport: true`, and then only scrubbed. */
  readonly inputMessages?: unknown
  readonly outputMessages?: unknown
  /** Content: the agent's system instructions, as `gen_ai.system_instructions`. */
  readonly systemInstructions?: string | undefined
  readonly attributes?: SpanAttributes | undefined
  readonly startMs: number
  readonly endMs: number
  readonly error?: { readonly name: string; readonly message: string } | undefined
  /** A carrier from `context.propagation.inject`, to parent the run under an earlier span. */
  readonly parent?: TelemetryCarrier | undefined
}

export interface HeraAgentTelemetry {
  /** Pass to Pi as its telemetry context. */
  readonly context: TelemetryContext
  readonly conversationId: (piConversation: string | number) => string
  readonly invokeAgent: (input: InvokeAgentInput) => void
  /** Export what has ended; call it, via `waitUntil`, at the end of each request and alarm. */
  readonly flush: () => Promise<void>
  readonly shutdown: () => Promise<void>
}

interface Built {
  readonly pipeline: Pipeline
  readonly rules: ScrubRules
}

/** Core's resolved config, or `undefined` for a sink without its URL or token, or a config core refuses. */
function resolve(options: HeraAgentTelemetryOptions): ResolvedTelemetryConfig | undefined {
  const { baseUrl, token } = options.sink
  if (baseUrl === undefined || baseUrl.trim() === "" || token === undefined) return undefined
  try {
    return resolveTelemetryConfig({
      service: options.service,
      environment: options.environment,
      version: options.version,
      sink: { baseUrl, token },
      timeoutMs: options.timeoutMs,
      fetch: options.fetch,
    })
  } catch {
    // Built lazily inside Pi's span calls: a refused config must never throw into the agent.
    return undefined
  }
}

const FALLBACK_RULES: ScrubRules = { secretShapes: GITLEAKS_SHAPES }

function build(options: HeraAgentTelemetryOptions): Built {
  const resolved = resolve(options)
  const pipeline = makePipeline({
    config: resolved,
    contentExport: options.contentExport === true,
    waitUntil: options.waitUntil,
    maxBufferedSpans: options.maxBufferedSpans ?? DEFAULT_MAX_BUFFERED_SPANS,
    onExport: options.onExport,
  })
  return { pipeline, rules: resolved?.rules ?? FALLBACK_RULES }
}

/**
 * Scrubbed GenAI telemetry for one tenant Durable Object. Construction does nothing: the pipeline
 * is built on the first span, per instance, and nothing is shared between instances.
 */
function make(options: HeraAgentTelemetryOptions): HeraAgentTelemetry {
  const state: { built: Built | undefined } = { built: undefined }
  const get = (): Built => (state.built ??= build(options))
  const now = (): number => Date.now()
  const open = (spanOptions: StartSpanOptions): AgentSpan => {
    const { pipeline } = get()
    const span = new AgentSpan(spanOptions, { onEnd: pipeline.end, now })
    pipeline.start(span.spanId)
    return span
  }
  const conversationId = (piConversation: string | number) => `${options.tenant}/${piConversation}`
  return {
    context: makePiContext({ open, tenant: options.tenant, content: options.contentExport === true, rules: () => get().rules, now }),
    conversationId,
    invokeAgent(input) {
      const content = options.contentExport === true
      const parent = extractCarrier(input.parent)
      const span = open({
        name: `invoke_agent ${input.agent}`,
        parent: parent?.parent,
        startMs: input.startMs,
        attributes: toAttributes({
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": input.agent,
          "gen_ai.system": input.provider,
          "gen_ai.provider.name": input.provider,
          "gen_ai.request.model": input.model,
          "gen_ai.response.model": input.responseModel ?? input.model,
          "gen_ai.conversation.id": conversationId(input.conversationId),
          "gen_ai.usage.input_tokens": input.usage?.inputTokens,
          "gen_ai.usage.output_tokens": input.usage?.outputTokens,
          "hera.tenant": options.tenant,
          // Skipped here as an optimisation only; the pipeline's scrub is the gate.
          "gen_ai.input.messages": content ? JSON.stringify(input.inputMessages ?? []) : undefined,
          "gen_ai.output.messages": content ? JSON.stringify(input.outputMessages ?? []) : undefined,
          "gen_ai.system_instructions":
            content && input.systemInstructions !== undefined
              ? JSON.stringify([{ type: "text", content: capText(input.systemInstructions) }])
              : undefined,
          ...input.attributes,
        }),
      })
      if (input.error) span.recordException(input.error, get().rules)
      span.end(input.endMs)
    },
    flush: () => (state.built ? state.built.pipeline.flush() : Promise.resolve()),
    shutdown: () => (state.built ? state.built.pipeline.flush() : Promise.resolve()),
  }
}

export const HeraAgentTelemetry = { make } as const
