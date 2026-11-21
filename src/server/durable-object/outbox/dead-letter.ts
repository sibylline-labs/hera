import { type HeraOutboxBackoffOptions, type HeraOutboxDeadLetter, type HeraOutboxRecord } from "./types.js"
import { coerceOutboxRow, computeOutboxBackoffMs, type RawOutboxSqlRow } from "./schema.js"
import { OUTBOX_COLUMNS } from "./store.js"

/** One failed delivery of a row the drain sent, with its redacted reason. */
export interface OutboxAttemptFailure {
  readonly id: string
  readonly reason: string
}

/**
 * Records failed attempts in one transaction. Each row is re-read inside it, so a row
 * another drain acknowledged or moved meanwhile is skipped, and `attempts` counts from what is
 * stored, never from the drain's snapshot. Below `maxAttempts` a row is backed off on its own; at
 * `maxAttempts` it moves to `_hera_outbox_dead_letter`. Answers how many rows it recorded and the
 * rows it moved.
 */
export function recordOutboxFailures(options: {
  readonly storage: DurableObjectStorage
  readonly failures: ReadonlyArray<OutboxAttemptFailure>
  readonly nowMs: number
  readonly backoff: HeraOutboxBackoffOptions
  readonly maxAttempts: number
}): { readonly recorded: number; readonly deadLettered: ReadonlyArray<HeraOutboxDeadLetter<string>> } {
  const { storage, nowMs } = options
  let recorded = 0
  const moved: Array<HeraOutboxDeadLetter<string>> = []
  storage.transactionSync(() => {
    for (const failure of options.failures) {
      const row = storage.sql
        .exec(`SELECT ${OUTBOX_COLUMNS} FROM _hera_outbox WHERE id = ?`, failure.id)
        .toArray()[0] as unknown as RawOutboxSqlRow | undefined
      if (row === undefined) {
        continue
      }
      recorded += 1
      const attempts = Number(row.attempts) + 1
      if (attempts < options.maxAttempts) {
        storage.sql
          .exec(
            "UPDATE _hera_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
            attempts,
            nowMs + computeOutboxBackoffMs(attempts, options.backoff),
            failure.reason,
            failure.id
          )
          .toArray()
        continue
      }
      storage.sql
        .exec(
          `INSERT INTO _hera_outbox_dead_letter (${OUTBOX_COLUMNS}, dead_lettered_at)
           SELECT id, org_id, event_type, payload_json, request_id, traceparent, ?, next_attempt_at, ?, created_at, ?
           FROM _hera_outbox WHERE id = ?`,
          attempts,
          failure.reason,
          nowMs,
          failure.id
        )
        .toArray()
      storage.sql.exec("DELETE FROM _hera_outbox WHERE id = ?", failure.id).toArray()
      const record = coerceOutboxRow({ ...row, attempts, last_error: failure.reason })
      moved.push({ ...record, deadLetteredAt: nowMs })
    }
  })
  return { recorded, deadLettered: moved }
}

export function readDeadLetteredOutboxRecords(
  sqlStorage: SqlStorage
): ReadonlyArray<HeraOutboxDeadLetter<string>> {
  const rows = sqlStorage
    .exec(
      `SELECT ${OUTBOX_COLUMNS}, dead_lettered_at FROM _hera_outbox_dead_letter
       ORDER BY created_at ASC, id ASC`
    )
    .toArray() as unknown as Array<RawOutboxSqlRow & { readonly dead_lettered_at: number }>
  return rows.map((row) => ({ ...coerceOutboxRow(row), deadLetteredAt: Number(row.dead_lettered_at) }))
}

/**
 * Moves dead letters (the named ids, or every one) back into `_hera_outbox`, due now with zero
 * attempts, keeping their `created_at` and `last_error`. The only delete from the dead-letter table.
 */
export function replayDeadLetteredOutboxRecords(
  storage: DurableObjectStorage,
  ids: ReadonlyArray<string> | undefined,
  nowMs: number
): ReadonlyArray<HeraOutboxRecord<string>> {
  return storage.transactionSync(() => {
    const chosen = readDeadLetteredOutboxRecords(storage.sql).filter(
      (record) => ids === undefined || ids.includes(record.id)
    )
    for (const record of chosen) {
      storage.sql
        .exec(
          `INSERT INTO _hera_outbox (${OUTBOX_COLUMNS})
           SELECT id, org_id, event_type, payload_json, request_id, traceparent, 0, ?, last_error, created_at
           FROM _hera_outbox_dead_letter WHERE id = ?`,
          nowMs,
          record.id
        )
        .toArray()
      storage.sql.exec("DELETE FROM _hera_outbox_dead_letter WHERE id = ?", record.id).toArray()
    }
    return chosen
  })
}
