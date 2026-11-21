import type * as Effect from "effect/Effect"
import type { HeraTelemetry } from "../../core/telemetry/types.js"
import type * as Schema from "effect/Schema"
import type { HeraCtx } from "../../core/context/index.js"
import type { AnyHeraDefinedError, HeraError } from "../../core/errors/index.js"
import type { HeraLogger } from "../../core/logger/index.js"

/** The part of a Workers queue `Message` the consumer reads. */
export type HeraQueueMessageInput = Pick<Message<unknown>, "id" | "timestamp" | "attempts" | "body">

/** The part of a Workers `MessageBatch` the consumer reads and settles. */
export interface HeraQueueBatchInput {
  readonly queue: string
  readonly messages: ReadonlyArray<HeraQueueMessageInput>
  ackAll(): void
  retryAll(options?: QueueRetryOptions): void
}

/** The producer's trace context a traced body (`queueSink({ trace: true })`) carried. */
export interface HeraQueueMessageTrace {
  /** The producer span's W3C `traceparent`; the batch span links to it. */
  readonly traceparent?: string | undefined
  /** The producer's request id. */
  readonly requestId?: string | undefined
}

/** A message whose body decoded against the consumer's schema. */
export interface HeraQueueMessage<A> extends HeraQueueMessageTrace {
  readonly id: string
  readonly timestamp: Date
  readonly attempts: number
  readonly body: A
}

/** One structural decode issue: where and what kind, never the value. */
export interface HeraQueueDecodeIssue {
  readonly path: ReadonlyArray<string | number>
  readonly code: string
}

/** A message whose body failed decode. It settles with its batch; `body` is the raw input. */
export interface HeraQueueInvalidMessage extends HeraQueueMessageTrace {
  readonly id: string
  readonly timestamp: Date
  readonly attempts: number
  readonly body: unknown
  readonly issues: ReadonlyArray<HeraQueueDecodeIssue>
}

/** What the handler sees: the decoded messages and, beside them, the ones that failed decode. */
export interface HeraQueueBatch<A> {
  readonly queue: string
  readonly messages: ReadonlyArray<HeraQueueMessage<A>>
  readonly invalid: ReadonlyArray<HeraQueueInvalidMessage>
}

export type HeraQueueError = HeraError | AnyHeraDefinedError

export interface HeraQueueConsumerSpec<
  S extends Schema.Top | undefined,
  Env,
  E extends HeraQueueError,
> {
  /** The consumer's name: its span, and its `HeraCtx.service` unless `service` is set. */
  readonly name: string
  readonly service?: string | undefined
  /** Decodes each body. Omitted: bodies pass through as `unknown` and `invalid` is empty. */
  readonly schema?: S
  /** Delay for a retryable failure that carries no `retryAfter`; defaults to 30. */
  readonly retryDelaySeconds?: number | undefined
  /** Defaults to `createHeraLogger({ service })`. */
  readonly logger?: HeraLogger | undefined
  /** Traces and exports each batch as one invocation; `waitUntil` comes from the handler's `ctx`. */
  readonly telemetry?: HeraTelemetry | ((env: Env) => HeraTelemetry | undefined) | undefined
  readonly handler: (
    batch: HeraQueueBatch<S extends Schema.Top ? S["Type"] : unknown>,
    env: Env
  ) => Effect.Effect<void, E, HeraCtx>
}

/** The Worker `queue` handler: settles the batch exactly once and never rejects. */
export type HeraQueueConsumer<Env> = (
  batch: HeraQueueBatchInput,
  env: Env,
  ctx?: { readonly waitUntil: (promise: Promise<unknown>) => void }
) => Promise<void>
