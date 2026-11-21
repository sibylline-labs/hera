import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai"
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream"
import { thinkingLevelFor, type HeraAgentModel } from "../models/catalog.js"
import { recordChatContent } from "../telemetry/content-recorder.js"
import { deniedEgressHost } from "./allowlist.js"
import type { HeraAgentMeter } from "./meter.js"
import { EMPTY_READING, foldReading, readChunk, type ChunkReading } from "./provider-chunk.js"

export interface MeteredStreamsDeps {
  readonly meter: HeraAgentMeter
  /** The models this agent may run, with their thinking levels: the primary first. */
  readonly selection: ReadonlyArray<HeraAgentModel>
  /** The pi-ai model of the catalog fallback, re-issued once when the primary fails empty. */
  readonly fallback: Model<Api> | undefined
  readonly now: () => number
  /** Which operation a request belongs to, by pi-ai's `options.sessionId`; absent, rows carry no `operationId`. */
  readonly operationFor?: ((sessionId: string | undefined) => Promise<string | undefined>) | undefined
}

type Options = StreamOptions | SimpleStreamOptions | undefined

/**
 * Google's documented placeholder for a `functionCall` part whose thought signature is unknown
 * (https://ai.google.dev/gemini-api/docs/thought-signatures). pi-ai drops another model's
 * signatures when it replays history, and `gemini-4-argon` refuses unsigned tool-call history
 * with `400 Function call is missing a thought_signature`.
 */
const UNSIGNED_FUNCTION_CALL = "skip_thought_signature_validator"

type PayloadPart = { readonly functionCall?: unknown; readonly thoughtSignature?: unknown }
type PayloadContent = { readonly parts?: ReadonlyArray<PayloadPart> }

/** `payload` with every unsigned `functionCall` part carrying the placeholder signature. */
function signFunctionCalls(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload
  const contents = (payload as { readonly contents?: unknown }).contents
  if (!Array.isArray(contents)) return payload
  return {
    ...payload,
    contents: (contents as ReadonlyArray<PayloadContent>).map((content) =>
      Array.isArray(content.parts)
        ? {
            ...content,
            parts: content.parts.map((part) =>
              part.functionCall !== undefined && part.thoughtSignature === undefined
                ? { ...part, thoughtSignature: UNSIGNED_FUNCTION_CALL }
                : part
            ),
          }
        : content
    ),
  }
}

/** The fallback's options: the caller's `onPayload` runs first, then the unsigned calls are signed. */
function withSignedFunctionCalls(options: Options): Options {
  const onPayload = options?.onPayload
  return {
    ...options,
    onPayload: async (payload: unknown, model: Model<Api>) =>
      signFunctionCalls((await onPayload?.(payload, model)) ?? payload),
  }
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** An already-failed stream: the request never left the object. */
export function refusedStream(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  }
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error: message })
    stream.end(message)
  })
  return stream
}

const isTerminal = (e: AssistantMessageEvent) => e.type === "done" || e.type === "error"

/** One metered request: allowlist first, then the inner stream with its chunks observed. */
function issue(
  inner: ProviderStreams,
  deps: MeteredStreamsDeps,
  simple: boolean,
  model: Model<Api>,
  context: TranscriptContext,
  options: Options
): { readonly stream: AssistantMessageEventStream; readonly settle: () => void; readonly refused: boolean } {
  const denied = deniedEgressHost(model.baseUrl)
  if (denied !== undefined) {
    return { stream: refusedStream(model, `agent_egress_host_denied: ${denied}`), settle: () => {}, refused: true }
  }
  let reading: ChunkReading = EMPTY_READING
  const observe = options?.onProviderStreamEvent
  const observed = {
    ...options,
    onProviderStreamEvent: async (chunk: unknown, m: Model<Api>) => {
      reading = foldReading(reading, readChunk(chunk))
      await observe?.(chunk, m)
    },
  }
  let stream: AssistantMessageEventStream
  try {
    stream = simple
    ? inner.streamSimple(model, context, withThinking(observed as SimpleStreamOptions, model.id, deps.selection))
    : inner.stream(model, context, observed)
  } catch (error) {
    // An adapter that throws before streaming (the Google one does for a missing key) fails the request.
    return { stream: refusedStream(model, `agent_egress_failed: ${error instanceof Error ? error.name : "unknown"}`), settle: () => {}, refused: true }
  }
  // Resolved when the request begins, while its operation is certainly the placed one.
  const operation = deps.operationFor?.(options?.sessionId)?.catch(() => undefined)
  const settle = () => {
    if (reading.usage === undefined) return
    const usage = reading.usage
    // With neither the gateway log id nor a response id the request cannot be deduplicated; it is
    // still metered under a fresh key rather than dropped (under-metering is the worse failure).
    const key = reading.logId ?? reading.responseId ?? `unkeyed-${crypto.randomUUID()}`
    const atMs = deps.now()
    const write = (operationId: string | undefined) =>
      deps.meter.record({
        logId: key,
        atMs,
        model: model.id,
        inputTokens: usage.promptTokens,
        candidatesTokens: usage.candidatesTokens,
        thoughtsTokens: usage.thoughtsTokens,
        cachedTokens: usage.cachedTokens,
        totalTokens: usage.totalTokens,
        ...(operationId === undefined ? {} : { operationId }),
      })
    if (operation === undefined) write(undefined)
    else void operation.then(write)
  }
  return { stream, settle, refused: false }
}

/** The catalog's thinking level wins over whatever the session asked for; none means thinking off. */
function withThinking(
  options: SimpleStreamOptions,
  modelId: string,
  selection: ReadonlyArray<HeraAgentModel>
): SimpleStreamOptions {
  const { reasoning: _requested, ...rest } = options
  const level = thinkingLevelFor(modelId, selection)
  return level === undefined || level === "off" ? rest : { ...rest, reasoning: level }
}

type Events = AsyncIterator<AssistantMessageEvent>

/** The request a drain forwards, for its content: what was sent and the span Pi passed with it. */
interface Sent {
  readonly context: TranscriptContext
  readonly options: Options
}

/**
 * Forwards the rest of `events` into `out` after `held`, metering once when the request settles and
 * recording its content on the request's chat span (a no-op unless that span records content).
 */
async function drain(
  out: AssistantMessageEventStream,
  events: Events,
  first: IteratorResult<AssistantMessageEvent> | undefined,
  held: ReadonlyArray<AssistantMessageEvent>,
  settle: () => void,
  sent?: Sent | undefined
): Promise<void> {
  for (const event of held) out.push(event)
  for (let next = first ?? (await events.next()); !next.done; next = await events.next()) {
    const event = next.value
    if (isTerminal(event)) {
      settle()
      // The chat span is still open here: pi-ai ends it only once this terminal event reaches it.
      if (sent !== undefined) recordChatContent(sent.options?.telemetry, sent.context.messages, event.type === "done" ? event.message : event.error)
      out.push(event)
      out.end(event.type === "done" ? event.message : event.error)
      return
    }
    out.push(event)
  }
  settle()
  out.end()
}

/**
 * Wraps a `ProviderStreams` with Hera's egress rules:
 *  - a model whose `baseUrl` host is off the allowlist fails closed, before any request;
 *  - `streamSimple` runs at the catalog's thinking level for the model, or with thinking off;
 *  - one meter row per request from the last `usageMetadata` chunk, keyed `cf-aig-log-id`;
 *  - a primary that fails before any content is re-issued once on the catalog fallback, with every
 *    unsigned `functionCall` part of its history signed with the placeholder.
 */
export function meteredStreams(inner: ProviderStreams, deps: MeteredStreamsDeps): ProviderStreams {
  const run = (simple: boolean) => (model: Model<Api>, context: TranscriptContext, options?: Options) => {
    const out = createAssistantMessageEventStream()
    const forward = async () => {
      const primary = issue(inner, deps, simple, model, context, options)
      const events = primary.stream[Symbol.asyncIterator]()
      const held: AssistantMessageEvent[] = []
      let next = await events.next()
      while (!next.done && next.value.type === "start") {
        held.push(next.value)
        next = await events.next()
      }
      const fallback = deps.fallback
      const failedEmpty = !next.done && next.value.type === "error" && next.value.reason === "error"
      // A refusal is Hera's own decision, not a model failure: it never falls back.
      if (failedEmpty && !primary.refused && fallback !== undefined && fallback.id !== model.id) {
        primary.settle()
        const second = issue(inner, deps, simple, fallback, context, withSignedFunctionCalls(options))
        return drain(out, second.stream[Symbol.asyncIterator](), undefined, [], second.settle, { context, options })
      }
      return drain(out, events, next, held, primary.settle, { context, options })
    }
    forward().catch((error: unknown) => {
      const failed = refusedStream(model, `agent_egress_failed: ${error instanceof Error ? error.name : "unknown"}`)
      void drain(out, failed[Symbol.asyncIterator](), undefined, [], () => {})
    })
    return out
  }
  return { stream: run(false), streamSimple: run(true) }
}
