import { describeException } from "../../../core/telemetry/exception.js"
import type { DescribedException } from "../../../core/telemetry/types.js"
import type { ScrubRules } from "../../../core/logger/types.js"

/** A value a span attribute may hold; the OTLP encoder maps each to one `AnyValue`. */
export type AgentAttributeValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string>
  | ReadonlyArray<number>
  | ReadonlyArray<boolean>

export type AgentAttributes = Readonly<Record<string, AgentAttributeValue>>

export interface AgentSpanEvent {
  readonly name: string
  readonly timeMs: number
  readonly attributes: AgentAttributes
}

export interface AgentSpanLink {
  readonly traceId: string
  readonly spanId: string
  readonly attributes: AgentAttributes
}

export type AgentSpanStatus = "unset" | "ok" | "error"

/** A finished span as the pipeline reads it: a plain value, never mutated after `end`. */
export interface EndedSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string | undefined
  readonly name: string
  readonly startMs: number
  readonly endMs: number
  readonly attributes: AgentAttributes
  readonly events: ReadonlyArray<AgentSpanEvent>
  readonly links: ReadonlyArray<AgentSpanLink>
  readonly status: AgentSpanStatus
  /** Built only by `describeException`: a scrubbed stack and a fingerprint, never raw text. */
  readonly exception?: DescribedException | undefined
  /** Events dropped before export (content events, Pi's per-block events). */
  readonly droppedEvents: number
}

const ALL_ZERO = /^0+$/

/** `bytes` random bytes as lowercase hex, never all zero (an invalid W3C id). */
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  let hex = ""
  while (hex === "" || ALL_ZERO.test(hex)) {
    crypto.getRandomValues(buffer)
    hex = Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  return hex
}

export interface StartSpanOptions {
  readonly name: string
  /** The trace to join and the span to parent under; absent, the span is a new trace's root, and with no `spanId` a root in that trace. */
  readonly parent?: { readonly traceId: string; readonly spanId?: string | undefined } | undefined
  readonly attributes?: AgentAttributes | undefined
  readonly links?: ReadonlyArray<AgentSpanLink> | undefined
  readonly startMs?: number | undefined
}

/**
 * One span being recorded. Mutable until `end`, which hands a snapshot to `onEnd` once; every
 * call after that is ignored, so a callback that throws and then settles cannot emit twice.
 */
export class AgentSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly startMs: number
  #name: string
  #attributes: Record<string, AgentAttributeValue>
  #events: AgentSpanEvent[] = []
  #links: AgentSpanLink[]
  #status: AgentSpanStatus = "unset"
  #exception: DescribedException | undefined
  #droppedEvents = 0
  #ended = false
  readonly #onEnd: (span: EndedSpan) => void
  readonly #now: () => number

  constructor(options: StartSpanOptions, hooks: { readonly onEnd: (span: EndedSpan) => void; readonly now: () => number }) {
    this.traceId = options.parent?.traceId ?? randomHex(16)
    this.spanId = randomHex(8)
    this.parentSpanId = options.parent?.spanId
    this.#onEnd = hooks.onEnd
    this.#now = hooks.now
    this.startMs = options.startMs ?? hooks.now()
    this.#name = options.name
    this.#attributes = { ...options.attributes }
    this.#links = [...(options.links ?? [])]
  }

  get ended(): boolean {
    return this.#ended
  }

  hasAttribute(key: string): boolean {
    return key in this.#attributes
  }

  updateName(name: string): void {
    if (!this.#ended) this.#name = name
  }

  setAttributes(attributes: AgentAttributes): void {
    if (!this.#ended) Object.assign(this.#attributes, attributes)
  }

  addEvent(name: string, attributes: AgentAttributes = {}): void {
    if (!this.#ended) this.#events.push({ name, timeMs: this.#now(), attributes })
  }

  /** Counts an event the adapter chose not to record, so the export says something was cut. */
  dropEvent(): void {
    if (!this.#ended) this.#droppedEvents += 1
  }

  addLink(link: AgentSpanLink): void {
    if (!this.#ended) this.#links.push(link)
  }

  setStatus(status: AgentSpanStatus): void {
    if (!this.#ended) this.#status = status
  }

  /** Marks the span errored with `value` described: header redacted, stack scrubbed, fingerprinted. */
  recordException(value: unknown, rules: ScrubRules): void {
    if (this.#ended) return
    this.#status = "error"
    this.#exception = describeException(value, rules)
  }

  end(endMs?: number): void {
    if (this.#ended) return
    this.#ended = true
    this.#onEnd({
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId !== undefined ? { parentSpanId: this.parentSpanId } : {}),
      name: this.#name,
      startMs: this.startMs,
      endMs: endMs ?? this.#now(),
      attributes: { ...this.#attributes },
      events: [...this.#events],
      links: [...this.#links],
      status: this.#status,
      ...(this.#exception !== undefined ? { exception: this.#exception } : {}),
      droppedEvents: this.#droppedEvents,
    })
  }
}
