import * as Effect from "effect/Effect"
import { readAmbientCorrelation } from "../../../core/logger/ambient.js"
import { type RequestId } from "../../../core/schema/index.js"
import { ambientTraceparent } from "../../../core/telemetry/traceparent.js"
import { wrapSqlError } from "../sql/storage-adapter.js"
import { brandSyncEffect, SyncTx } from "../sql/sync-tx.js"
import { DEFAULT_ORDERED_ID_PREFIX, orderedOutboxId, takeOutboxSeq } from "./sequence.js"
import {
  type AnyOutboxEventInput,
  type HeraOrderedOutboxRecord,
  type HeraOutboxOrdering,
} from "./types.js"
import {
  type HeraOutboxRecord,
  HeraSqlError,
  type SyncEffect,
} from "../types.js"
import {
  coerceOutboxRow,
  DOMAIN_ALARM_META_KEY,
  generateOutboxEventId,
  type RawOutboxSqlRow,
} from "./schema.js"

export function enqueueOutboxRecord<Payload = unknown>(options: {
  readonly storage: DurableObjectStorage
  readonly orgId: string
  readonly now: () => number
  readonly getActiveRequestId: () => RequestId | undefined
  readonly event: AnyOutboxEventInput<Payload>
}): SyncEffect<HeraOutboxRecord<string> | HeraOrderedOutboxRecord<string>, HeraSqlError> {
  // The enqueuing fiber's span and request id; synchronous reads, so the write stays in its tx.
  const ambient = Effect.withFiber((fiber) => {
    return Effect.succeed({
      traceparent: ambientTraceparent(fiber),
      requestId: readAmbientCorrelation(fiber.context, {}).requestId,
    })
  })
  return brandSyncEffect(Effect.flatMap(ambient, (fromFiber) => SyncTx.try({
    try: () => {
      const { event } = options
      if (typeof event.type !== "string" || event.type.trim().length === 0) {
        throw new HeraSqlError({
          operation: "enqueueOutbox",
          reason: "Outbox event type must be a non-empty string",
        })
      }
      const nowMs = options.now()
      const requestId =
        event.requestId !== undefined
          ? String(event.requestId)
          : (options.getActiveRequestId() ?? fromFiber.requestId ?? null)
      const row: OutboxRowFields = {
        orgId: options.orgId,
        type: event.type,
        requestId,
        traceparent: fromFiber.traceparent ?? null,
        nextAttemptAt:
          event.availableAt !== undefined && Number.isFinite(event.availableAt) ? event.availableAt : nowMs,
      }
      if (event.ordered === true) {
        // A savepoint inside a caller's transaction, a transaction of its own on a bare enqueue:
        // the number is taken only if the row is written.
        return options.storage.transactionSync(() => {
          const taken = takeOutboxSeq(options.storage.sql, nowMs)
          const payload = typeof event.payload === "function"
            ? (event.payload as (seq: number) => Payload)(taken.seq)
            : event.payload
          const id = orderedOutboxId(event.idPrefix ?? DEFAULT_ORDERED_ID_PREFIX, taken.seq)
          const record = insertOutboxRow(options.storage.sql, { ...row, id, payload, createdAt: taken.createdAt })
          return { ...record, seq: taken.seq }
        })
      }
      const id =
        typeof event.id === "string" && event.id.trim().length > 0
          ? event.id
          : generateOutboxEventId(nowMs)
      return insertOutboxRow(options.storage.sql, { ...row, id, payload: event.payload, createdAt: nowMs })
    },
    catch: wrapSqlError("enqueueOutbox", "Outbox insert failed"),
  })))
}

interface OutboxRowFields {
  readonly orgId: string
  readonly type: string
  readonly requestId: string | null
  readonly traceparent: string | null
  readonly nextAttemptAt: number
}

function insertOutboxRow(
  sqlStorage: SqlStorage,
  row: OutboxRowFields & { readonly id: string; readonly payload: unknown; readonly createdAt: number }
): HeraOutboxRecord<string> {
  const payloadJson = JSON.stringify(row.payload ?? null)
  sqlStorage
    .exec(
      `INSERT INTO _hera_outbox (
        id, org_id, event_type, payload_json, request_id, traceparent, attempts, next_attempt_at, last_error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
      row.id,
      row.orgId,
      row.type,
      payloadJson,
      row.requestId,
      row.traceparent,
      row.nextAttemptAt,
      row.createdAt
    )
    .toArray()
  return {
    id: row.id,
    orgId: row.orgId,
    type: row.type,
    eventType: row.type,
    payload: row.payload,
    payloadJson,
    requestId: row.requestId,
    ...(row.traceparent !== null ? { traceparent: row.traceparent } : {}),
    attempts: 0,
    nextAttemptAt: row.nextAttemptAt,
    lastError: null,
    createdAt: row.createdAt,
  }
}

export function readPendingOutboxRecords(
  sqlStorage: SqlStorage
): ReadonlyArray<HeraOutboxRecord<string>> {
  const rows = sqlStorage
    .exec(`SELECT ${OUTBOX_COLUMNS} FROM _hera_outbox ORDER BY created_at ASC, id ASC`)
    .toArray() as unknown as Array<RawOutboxSqlRow>
  return rows.map(coerceOutboxRow)
}

/** The `_hera_outbox` columns `coerceOutboxRow` reads, in its order. */
export const OUTBOX_COLUMNS =
  "id, org_id, event_type, payload_json, request_id, traceparent, attempts, next_attempt_at, last_error, created_at"

/**
 * The rows a drain sends, in `(created_at, id)` order. `strict`: the due prefix, up to the first
 * row not yet due, so a backed-off head holds back every row behind it and a stream is delivered in
 * the order it was written. `independent`: every due row.
 */
export function readDueOutboxBatch(
  sqlStorage: SqlStorage,
  nowMs: number,
  limit: number,
  ordering: HeraOutboxOrdering
): ReadonlyArray<HeraOutboxRecord<string>> {
  if (ordering === "independent") {
    const due = sqlStorage
      .exec(
        `SELECT ${OUTBOX_COLUMNS} FROM _hera_outbox WHERE next_attempt_at <= ?
         ORDER BY created_at ASC, id ASC LIMIT ?`,
        nowMs,
        limit
      )
      .toArray() as unknown as Array<RawOutboxSqlRow>
    return due.map(coerceOutboxRow)
  }
  const rows = sqlStorage
    .exec(`SELECT ${OUTBOX_COLUMNS} FROM _hera_outbox ORDER BY created_at ASC, id ASC LIMIT ?`, limit)
    .toArray() as unknown as Array<RawOutboxSqlRow>
  const firstNotDue = rows.findIndex((row) => Number(row.next_attempt_at) > nowMs)
  return (firstNotDue === -1 ? rows : rows.slice(0, firstNotDue)).map(coerceOutboxRow)
}

export function acknowledgeOutboxBatch(
  storage: DurableObjectStorage,
  batch: ReadonlyArray<HeraOutboxRecord<string>>
): void {
  storage.transactionSync(() => {
    for (const record of batch) {
      storage.sql.exec("DELETE FROM _hera_outbox WHERE id = ?", record.id).toArray()
    }
  })
}

/**
 * When the outbox can next send: under `strict` the head row's time, since nothing behind it goes
 * first; under `independent` the earliest row's time.
 */
export function readNextOutboxRetryAt(
  sqlStorage: SqlStorage,
  ordering: HeraOutboxOrdering
): number | null {
  const sql =
    ordering === "independent"
      ? "SELECT MIN(next_attempt_at) AS next_attempt_at FROM _hera_outbox"
      : "SELECT next_attempt_at FROM _hera_outbox ORDER BY created_at ASC, id ASC LIMIT 1"
  const rows = sqlStorage.exec(sql).toArray() as Array<{ next_attempt_at: number | null }>
  const headDue = rows[0]?.next_attempt_at
  return typeof headDue === "number" && Number.isFinite(headDue) ? headDue : null
}

export function readDomainAlarmAt(sqlStorage: SqlStorage): number | null {
  const rows = sqlStorage
    .exec(
      "SELECT value_int FROM _hera_alarm_meta WHERE key = ?",
      DOMAIN_ALARM_META_KEY
    )
    .toArray() as Array<{ value_int: number | null }>
  const val = rows[0]?.value_int
  return typeof val === "number" && Number.isFinite(val) ? val : null
}

export function clearDomainAlarmMeta(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    storage.sql
      .exec("DELETE FROM _hera_alarm_meta WHERE key = ?", DOMAIN_ALARM_META_KEY)
      .toArray()
  })
}

export function upsertDomainAlarmMeta(
  storage: DurableObjectStorage,
  atMs: number,
  nowMs: number
): void {
  storage.transactionSync(() => {
    storage.sql
      .exec(
        `INSERT INTO _hera_alarm_meta (key, value_int, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_int = excluded.value_int, updated_at = excluded.updated_at`,
        DOMAIN_ALARM_META_KEY,
        atMs,
        nowMs
      )
      .toArray()
  })
}
