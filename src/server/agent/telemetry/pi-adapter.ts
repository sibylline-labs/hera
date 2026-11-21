import type {
  SpanAttributes,
  SpanLink,
  SpanOptions,
  SpanStatus,
  TelemetryCarrier,
  TelemetryContext,
  TelemetryPropagation,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry"
import type { ScrubRules } from "../../../core/logger/types.js"
import { extractCarrier, injectCarrier, ROOT_SCOPE, type Scope } from "./carrier.js"
import { genAiEnd, genAiStart, isChatSpan, mayBeGenAi, PHASE_SPAN, toolPhase } from "./genai-map.js"
import type { AgentAttributes, AgentAttributeValue, AgentSpan, AgentSpanLink, StartSpanOptions } from "./span.js"

/** Pi's per-block event: one per completed text, thinking or tool-call block, so it is never recorded. */
export const PI_BLOCK_EVENT = "pi.ai.block"
/** Pi's first-chunk event, recorded as {@link FIRST_CHUNK_ATTRIBUTE} instead of an event. */
export const PI_FIRST_CHUNK_EVENT = "pi.ai.first_chunk"
export const FIRST_CHUNK_ATTRIBUTE = "first_chunk_latency_ms"

/** Pi attributes as span ones: undefined dropped, arrays copied. Scrubbing is the pipeline's job. */
export function toAttributes(attributes: SpanAttributes | undefined): AgentAttributes {
  const out: Record<string, AgentAttributeValue> = {}
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value !== undefined) out[key] = Array.isArray(value) ? [...(value as ReadonlyArray<string>)] : (value as string)
  }
  return out
}

interface Parts {
  readonly open: (options: StartSpanOptions) => AgentSpan
  readonly tenant: string
  /** Whether this instance records content (`contentExport`); the content recorder reads it. */
  readonly content: boolean
  readonly rules: () => ScrubRules
  readonly now: () => number
  readonly propagation: TelemetryPropagation
}

function linkOf(link: SpanLink): AgentSpanLink | undefined {
  return link.context instanceof PiSpan
    ? { traceId: link.context.span.traceId, spanId: link.context.span.spanId, attributes: toAttributes(link.attributes) }
    : undefined
}

function start<T>(
  parts: Parts,
  parent: Scope,
  options: SpanOptions,
  callback: (span: TelemetrySpan) => T | Promise<T>
): Promise<T> {
  const mapped = genAiStart(options.name, options.attributes ?? {})
  const piConversation = options.attributes?.["conversation.id"]
  const conv = piConversation !== undefined ? `${parts.tenant}/${String(piConversation)}` : parent.conv
  const links = (options.links ?? []).map(linkOf).filter((link): link is AgentSpanLink => link !== undefined)
  const span = parts.open({
    name: mapped.name,
    parent: parent.parent,
    attributes: toAttributes({ ...mapped.attributes, "gen_ai.conversation.id": conv, "hera.tenant": parts.tenant }),
    links,
  })
  // A span that is always dropped is no parent: its children parent under the nearest span that may
  // export. A carrier crosses isolates, so it names only a span sure to export (a model request).
  const childParent = mayBeGenAi(options.name) ? span.spanId : parent.parent?.spanId
  const exported = isChatSpan(options.name) ? span.spanId : parent.exported
  const pi = new PiSpan(parts, span, options.name, { parent: { traceId: span.traceId, spanId: childParent }, exported, conv })
  // pi-telemetry contract: the callback runs synchronously once, the span stays open until it
  // settles, and its failure is rethrown unchanged.
  let result: T | Promise<T>
  try {
    result = callback(pi)
  } catch (error) {
    span.recordException(error, parts.rules())
    span.end()
    return Promise.reject(error)
  }
  return Promise.resolve(result).then(
    (value) => {
      span.end()
      return value
    },
    (error: unknown) => {
      span.recordException(error, parts.rules())
      span.end()
      throw error
    }
  )
}

export class PiSpan implements TelemetrySpan {
  readonly propagation: TelemetryPropagation
  /** The chat span this span started and has not yet seen settle (tracked only when recording content). */
  #chat: AgentSpan | undefined
  constructor(
    private readonly parts: Parts,
    readonly span: AgentSpan,
    private readonly piName: string,
    readonly scope: Scope
  ) {
    this.propagation = parts.propagation
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    if (!this.parts.content || !isChatSpan(options.name)) return start(this.parts, this.scope, options, callback)
    let chat: AgentSpan | undefined
    const settled = start(this.parts, this.scope, options, (child) => {
      chat = (child as PiSpan).span
      this.#chat = chat
      return callback(child)
    })
    const clear = () => {
      if (this.#chat === chat) this.#chat = undefined
    }
    settled.then(clear, clear)
    return settled
  }

  /** Whether content may be recorded on this span and its chat child. */
  get content(): boolean {
    return this.parts.content
  }

  /** The open chat span this span started, for the egress to record a request's content on. */
  openChat(): AgentSpan | undefined {
    return this.#chat
  }

  addLink(link: SpanLink): void {
    const mapped = linkOf(link)
    if (mapped) this.span.addLink(mapped)
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    if (name === PI_BLOCK_EVENT) {
      this.span.dropEvent()
      return
    }
    if (name === PI_FIRST_CHUNK_EVENT) {
      if (!this.span.hasAttribute(FIRST_CHUNK_ATTRIBUTE)) {
        this.span.setAttributes({ [FIRST_CHUNK_ATTRIBUTE]: Math.max(0, this.parts.now() - this.span.startMs) })
      }
      return
    }
    this.span.addEvent(name, toAttributes(attributes))
  }

  setAttributes(attributes: SpanAttributes): void {
    const ended = genAiEnd(this.piName, attributes)
    const tool = this.piName === PHASE_SPAN ? toolPhase(attributes) : undefined
    if (tool) this.span.updateName(tool.name)
    this.span.setAttributes(toAttributes({ ...ended, ...tool?.attributes }))
  }

  setStatus(status: SpanStatus): void {
    if (status.status === "ok") {
      this.span.setStatus("ok")
      return
    }
    this.span.recordException({ name: status.error?.name ?? "Error", message: status.error?.message ?? "" }, this.parts.rules())
  }
}

class ExtractedParent implements TelemetryContext {
  readonly propagation: TelemetryPropagation
  constructor(private readonly parts: Parts, private readonly scope: Scope) {
    this.propagation = parts.propagation
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return start(this.parts, this.scope, options, callback)
  }
}

/** Pi's `TelemetryContext` over a lazily built pipeline: nothing exists until the first span starts. */
export function makePiContext(options: Omit<Parts, "propagation">): TelemetryContext {
  const propagation: TelemetryPropagation = {
    inject(context): TelemetryCarrier | undefined {
      return context instanceof PiSpan ? injectCarrier(context.span, context.scope.conv, context.scope.exported) : undefined
    },
    extract(carrier): TelemetryContext {
      const scope = extractCarrier(carrier)
      return scope === undefined ? self : new ExtractedParent(parts, scope)
    },
  }
  const parts: Parts = { ...options, propagation }
  const self: TelemetryContext = {
    propagation,
    startSpan: (spanOptions, callback) => start(parts, ROOT_SCOPE, spanOptions, callback),
  }
  return self
}
