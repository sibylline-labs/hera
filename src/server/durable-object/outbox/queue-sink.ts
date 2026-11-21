import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { summarizeRedactedReason } from "../sql/storage-adapter.js"
import {
  type HeraOutboxRecord,
  type OutboxDeliveryContext,
  type OutboxDeliverySink,
  type OutboxQueueBinding,
  type OutboxQueueContentType,
} from "../types.js"
import { wrapTraceEnvelope } from "../../queue/trace-envelope.js"
import { liftSinkOrHookResult } from "./sink-result.js"
import {
  type HeraOutboxQueueLimits,
  planQueueSends,
  QUEUE_LIMITS,
  utf8Bytes,
} from "./send-chunks.js"

/** One record as it goes on the queue: its body, the body's UTF-8 size, and its content type. */
export interface HeraOutboxEncodedMessage {
  readonly body: unknown
  readonly bytes: number
  readonly contentType?: OutboxQueueContentType | undefined
}

/** A record too large for one queue message, with its size (metadata included) and the limit. */
export interface HeraOutboxRejection {
  readonly record: HeraOutboxRecord
  readonly bytes: number
  readonly limit: number
}

export interface HeraOutboxQueueSinkOptions {
  /** The queue, or how to find it in `env`; defaults to `env.EVENTS`. */
  readonly binding?:
    | OutboxQueueBinding
    | ((env: unknown) => OutboxQueueBinding | undefined)
    | undefined
  /** Defaults to the record's `payload`, sized from `payloadJson`. A failure fails the batch. */
  readonly encode?:
    | ((record: HeraOutboxRecord) => Effect.Effect<HeraOutboxEncodedMessage, unknown, never>)
    | undefined
  /**
   * Sends each record that carries a `traceparent` or `requestId` as
   * `{ __heraTrace: { v: 1, traceparent?, requestId? }, payload }`, which `Hera.queueConsumer`
   * unwraps before decode and links to the producer's trace. Default `false`: the body is the bare
   * payload, for consumers that are not `Hera.queueConsumer`. Ignored when `encode` is set.
   */
  readonly trace?: boolean | undefined
  /** Each field defaults to `QUEUE_LIMITS`. */
  readonly limits?: Partial<HeraOutboxQueueLimits> | undefined
  /**
   * Runs for each rejected record after Hera logs `hera.outbox.event_rejected`. At least once: a
   * batch whose send fails is retried whole, rejections included. Its failure is logged, never
   * propagated.
   */
  readonly onOversize?:
    | ((rejection: HeraOutboxRejection) => Effect.Effect<void, unknown, never> | Promise<void> | void)
    | undefined
}

const payloadBody = (record: HeraOutboxRecord): Effect.Effect<HeraOutboxEncodedMessage> =>
  Effect.succeed({ body: record.payload, bytes: utf8Bytes(record.payloadJson) })

const tracedBody = (record: HeraOutboxRecord): Effect.Effect<HeraOutboxEncodedMessage> =>
  Effect.sync(() => {
    const body = wrapTraceEnvelope(record)
    return { body, bytes: body === record.payload ? utf8Bytes(record.payloadJson) : utf8Bytes(JSON.stringify(body)) }
  })

function resolveBinding(
  binding: HeraOutboxQueueSinkOptions["binding"],
  env: unknown
): OutboxQueueBinding | undefined {
  if (typeof binding === "function") {
    return binding(env)
  }
  return binding ?? (env as { readonly EVENTS?: OutboxQueueBinding } | undefined)?.EVENTS
}

function rejectOversize(
  context: OutboxDeliveryContext,
  rejection: HeraOutboxRejection,
  onOversize: HeraOutboxQueueSinkOptions["onOversize"]
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* context.logger.error("hera.outbox.event_rejected", {
      orgId: context.orgId,
      outboxId: rejection.record.id,
      type: rejection.record.type,
      bytes: rejection.bytes,
      limit: rejection.limit,
    })
    if (onOversize === undefined) {
      return
    }
    const hookExit = yield* Effect.exit(
      Effect.try({ try: () => onOversize(rejection), catch: (err) => err }).pipe(
        Effect.flatMap((res) => liftSinkOrHookResult(res))
      )
    )
    if (hookExit._tag === "Failure") {
      yield* context.logger.error("hera.outbox.on_oversize_failed", {
        orgId: context.orgId,
        outboxId: rejection.record.id,
        reason: summarizeRedactedReason(Cause.squash(hookExit.cause), "onOversize failed"),
      })
    }
  })
}

/**
 * An `OutboxDeliverySink` that sends a drained batch to a Cloudflare Queue: it encodes
 * each record, sends the ones that fit in order in `sendBatch` calls inside `limits`, each awaited
 * before the next, and rejects a record over one message (logged at error, then `onOversize`)
 * without blocking the rest. The batch is acknowledged when every send succeeds, rejected records
 * with it (reject the event, keep the state change, log loudly). The first failed send
 * fails the batch; chunks already sent stay sent, so delivery is at-least-once.
 */
export function queueSink(options: HeraOutboxQueueSinkOptions = {}): OutboxDeliverySink {
  const limits: HeraOutboxQueueLimits = { ...QUEUE_LIMITS, ...options.limits }
  const encode = options.encode ?? (options.trace === true ? tracedBody : payloadBody)
  const rejectLimit = Math.min(limits.maxMessageBytes, limits.maxBatchBytes)
  return (records, context) =>
    Effect.gen(function* () {
      const queue = resolveBinding(options.binding, context.env)
      if (queue === undefined || typeof queue.sendBatch !== "function") {
        return yield* Effect.fail(new Error("Outbox queue binding is not bound"))
      }
      const encoded = yield* Effect.forEach(records, (record) =>
        Effect.map(encode(record), (message) => ({ record, message, bytes: message.bytes }))
      )
      const plan = planQueueSends(encoded, limits)
      for (const item of plan.oversize) {
        const rejection = {
          record: item.record,
          bytes: item.bytes + limits.metadataBytes,
          limit: rejectLimit,
        }
        yield* rejectOversize(context, rejection, options.onOversize)
      }
      for (const batch of plan.batches) {
        const messages = batch.map(({ message }) =>
          message.contentType === undefined
            ? { body: message.body }
            : { body: message.body, contentType: message.contentType }
        )
        yield* Effect.tryPromise({ try: () => queue.sendBatch(messages), catch: (err) => err })
      }
    })
}
