import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { type HeraLogger } from "../../../core/logger/index.js"
import { summarizeRedactedReason } from "../sql/storage-adapter.js"
import { recordOutboxFailures } from "./dead-letter.js"
import type { HeraOutboxSettings } from "./options.js"
import {
  type HeraOutboxDeliveryReport,
  type HeraOutboxDrainResult,
  type HeraOutboxRecord,
  type HeraOutboxSinkResult,
  type OutboxDeliveryContext,
  type OutboxDeliverySink,
} from "./types.js"
import { queueSink } from "./queue-sink.js"
import { utf8Bytes } from "./send-chunks.js"
import { liftSinkOrHookResult } from "./sink-result.js"
import {
  acknowledgeOutboxBatch,
  readDueOutboxBatch,
  readNextOutboxRetryAt,
  readPendingOutboxRecords,
} from "./store.js"

/** Hera's queue body for a record when no sink is configured: the record without its storage columns. */
function heraRecordBody(record: HeraOutboxRecord<string>) {
  const body = {
    id: record.id,
    orgId: record.orgId,
    type: record.type,
    payload: record.payload,
    requestId: record.requestId,
    createdAt: record.createdAt,
  }
  return Effect.sync(() => ({ body, bytes: utf8Bytes(JSON.stringify(body)) }))
}

const defaultQueueSink = queueSink({ encode: heraRecordBody })

export function deliverToDefaultQueueSink(
  customSink: OutboxDeliverySink<any> | undefined,
  records: ReadonlyArray<HeraOutboxRecord<string>>,
  context: OutboxDeliveryContext<string>
): HeraOutboxSinkResult {
  const sink = (customSink ?? defaultQueueSink) as OutboxDeliverySink<string>
  return sink(records, context)
}

const FAILED_REASON = "Outbox delivery failed"

/** The batch's failures: every record when the sink failed, else the batch ids its report names. */
function failuresOf(
  batch: ReadonlyArray<HeraOutboxRecord<string>>,
  report: void | HeraOutboxDeliveryReport,
  sinkFailure: unknown
) {
  if (sinkFailure !== undefined) {
    const reason = summarizeRedactedReason(sinkFailure, "Outbox batch delivery failed")
    return batch.map((record) => ({ id: record.id, reason }))
  }
  const ids = new Set(batch.map((record) => record.id))
  const failed = report?.failed ?? []
  return failed
    .filter((failure) => ids.has(failure.id))
    .map((failure) => ({ id: failure.id, reason: summarizeRedactedReason(failure.reason, FAILED_REASON) }))
}

/**
 * One drain pass: the batch `ordering` picks goes to the sink; the records it did not
 * report failed are acknowledged; each failed record is backed off on its own and, at
 * `maxAttempts`, moves to `_hera_outbox_dead_letter` with one `hera.outbox.dead_lettered` error line.
 */
export function drainOutboxBatchEffect(options: {
  readonly storage: DurableObjectStorage
  /** Identity fields every log line carries (`orgId` on a tenant DO). */
  readonly logFields: Readonly<Record<string, unknown>>
  readonly nowMs: number
  readonly settings: HeraOutboxSettings
  readonly logger: HeraLogger
  /** False once storage was purged (`deleteAll`) while the delivery awaited. */
  readonly isInitialized: () => boolean
  readonly deliverBatch: (records: ReadonlyArray<HeraOutboxRecord<string>>) => HeraOutboxSinkResult
}): Effect.Effect<HeraOutboxDrainResult, never, never> {
  const { storage } = options
  const { ordering, batchSize, backoff, maxAttempts } = options.settings
  const settle = (drained: number, failed: number): HeraOutboxDrainResult => ({
    drained,
    failed,
    remaining: readPendingOutboxRecords(storage.sql).length,
    nextRetryAt: readNextOutboxRetryAt(storage.sql, ordering),
  })
  return Effect.gen(function* () {
    const batch = readDueOutboxBatch(storage.sql, options.nowMs, batchSize, ordering)
    if (batch.length === 0) {
      return settle(0, 0)
    }

    const deliveryExit = yield* Effect.exit(
      Effect.try({
        try: () => options.deliverBatch(batch),
        catch: (err) => err,
      }).pipe(Effect.flatMap((res) => liftSinkOrHookResult(res)))
    )
    if (!options.isInitialized()) {
      return { drained: 0, failed: 0, remaining: 0, nextRetryAt: null }
    }

    const sinkFailure = deliveryExit._tag === "Failure" ? Cause.squash(deliveryExit.cause) : undefined
    const failures = failuresOf(batch, deliveryExit._tag === "Success" ? deliveryExit.value : undefined, sinkFailure)
    const failedIds = new Set(failures.map((failure) => failure.id))
    acknowledgeOutboxBatch(storage, batch.filter((record) => !failedIds.has(record.id)))
    if (failures.length === 0) {
      return settle(batch.length, 0)
    }

    const { recorded, deadLettered } = recordOutboxFailures({
      storage,
      failures,
      nowMs: options.nowMs,
      backoff,
      maxAttempts,
    })
    if (recorded === 0) {
      return settle(batch.length - failures.length, 0)
    }
    yield* options.logger.warn("hera.outbox.flush_failed", {
      ...options.logFields,
      failedCount: recorded,
      reason: failures[0]?.reason,
    })
    for (const record of deadLettered) {
      yield* options.logger.error("hera.outbox.dead_lettered", {
        ...options.logFields,
        outboxId: record.id,
        type: record.type,
        attempts: record.attempts,
        lastError: record.lastError,
      })
    }
    return settle(batch.length - failures.length, recorded)
  })
}
