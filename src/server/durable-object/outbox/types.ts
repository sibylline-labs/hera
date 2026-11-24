import type * as Effect from "effect/Effect"
import type { HeraLogger } from "../../../core/logger/index.js"
import type { OrgId, RequestId } from "../../../core/schema/index.js"

export interface HeraOutboxEventInput<Payload = unknown> {
  readonly ordered?: false | undefined
  readonly id?: string | undefined
  readonly type: string
  readonly payload: Payload
  readonly requestId?: RequestId | string | undefined
  readonly availableAt?: number | undefined
}

/**
 * An enqueue that takes the object's next sequence number inside the caller's transaction: the
 * row's id is `idPrefix` + the number zero-padded to 16 digits, and `payload` may be built from it.
 * The number survives isolate eviction, is never reused, and goes back on a rollback.
 */
export interface HeraOrderedOutboxEventInput<Payload = unknown> {
  readonly ordered: true
  /** Default `outbox_seq_`. */
  readonly idPrefix?: string | undefined
  /** The id is derived from the sequence number. */
  readonly id?: never
  readonly type: string
  readonly payload: Payload | ((seq: number) => Payload)
  readonly requestId?: RequestId | string | undefined
  readonly availableAt?: number | undefined
}

/**
 * One pending outbox row. `orgId` holds the owning object's key: the `OrgId` on a
 * `TenantDurableObject`, the decoded `ctx.id.name` on a `KeyedDurableObject`.
 */
export interface HeraOutboxRecord<Owner extends string = OrgId> {
  readonly id: string
  readonly orgId: Owner
  readonly type: string
  readonly eventType: string
  readonly payload: unknown
  readonly payloadJson: string
  readonly requestId: string | null
  /** W3C `traceparent` of the span that enqueued the record, when it ran in one. */
  readonly traceparent?: string | undefined
  readonly attempts: number
  readonly nextAttemptAt: number
  readonly lastError: string | null
  readonly createdAt: number
}

/** What an enqueue's implementation takes; callers see the `HeraEnqueueOutbox` overloads. */
export type AnyOutboxEventInput<Payload = unknown> =
  | HeraOutboxEventInput<Payload>
  | HeraOrderedOutboxEventInput<Payload>

/** The record an ordered enqueue wrote: `seq` is the object's sequence number it took. */
export type HeraOrderedOutboxRecord<Owner extends string = OrgId> = HeraOutboxRecord<Owner> & {
  readonly seq: number
}

export interface HeraOutboxDrainResult {
  readonly drained: number
  readonly failed: number
  readonly remaining: number
  readonly nextRetryAt: number | null
}

export interface HeraOutboxBackoffOptions {
  readonly baseDelayMs?: number | undefined
  readonly maxDelayMs?: number | undefined
  readonly jitterRatio?: number | undefined
  readonly random?: (() => number) | undefined
}

/**
 * How a drain picks its batch. `strict` (the default) sends only the due prefix in the
 * order the rows were written, so a backed-off row holds every row behind it: a stream keeps its
 * order. `independent` sends every due row, so a backed-off row holds nothing behind it.
 */
export type HeraOutboxOrdering = "strict" | "independent"

/** One record a sink could not deliver; `reason` is redacted before it is stored or logged. */
export interface HeraOutboxFailure {
  readonly id: string
  readonly reason: unknown
}

/**
 * What a sink may resolve instead of nothing: the records of the batch it failed. Every other
 * record of the batch is acknowledged; an id outside the batch is ignored.
 */
export interface HeraOutboxDeliveryReport {
  readonly failed: ReadonlyArray<HeraOutboxFailure>
}

/** What a sink or a `deliverOutboxBatch` override returns: nothing (all delivered) or a report. */
export type HeraOutboxSinkResult =
  | Effect.Effect<void | HeraOutboxDeliveryReport, unknown, never>
  | Promise<void | HeraOutboxDeliveryReport>
  | void
  | HeraOutboxDeliveryReport

/** A record moved out of the outbox after `outboxMaxAttempts` failed attempts. */
export interface HeraOutboxDeadLetter<Owner extends string = OrgId> extends HeraOutboxRecord<Owner> {
  readonly deadLetteredAt: number
}

export type OutboxQueueContentType = "text" | "bytes" | "json" | "v8"

/** The slice of workerd's `Queue` a send uses, so `env.EVENTS: Queue<unknown>` satisfies it. */
export interface OutboxQueueBinding {
  sendBatch(
    messages: Iterable<{ readonly body: unknown; readonly contentType?: OutboxQueueContentType }>
  ): Promise<void>
}

/** What a Hera DO hands a sink beside the batch: its `env`, key (`OrgId` on a tenant) and logger. */
export interface OutboxDeliveryContext<Owner extends string = OrgId> {
  readonly env: unknown
  readonly orgId: Owner
  readonly logger: HeraLogger
}

export type OutboxDeliverySink<Owner extends string = OrgId> = (
  records: ReadonlyArray<HeraOutboxRecord<Owner>>,
  context: OutboxDeliveryContext<Owner>
) => HeraOutboxSinkResult
