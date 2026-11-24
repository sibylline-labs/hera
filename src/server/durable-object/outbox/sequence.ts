/**
 * The object's outbox sequence: one row, the last number an ordered enqueue took and the latest
 * `created_at` it stamped. A number is taken by a statement inside the enqueuing transaction, so it
 * survives isolate eviction, is never reused, and goes back when that transaction rolls back.
 */
export const HERA_OUTBOX_SEQ_TABLE = "_hera_outbox_seq"

export const HERA_OUTBOX_SEQ_DDL = `CREATE TABLE IF NOT EXISTS ${HERA_OUTBOX_SEQ_TABLE} (
    id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`

export const DEFAULT_ORDERED_ID_PREFIX = "outbox_seq_"

/** Digits in an ordered row's id, so string order on `id` is numeric order on `seq`. */
const ORDERED_ID_WIDTH = 16

export interface TakenOutboxSeq {
  readonly seq: number
  /** `max(nowMs, the last ordered row's created_at)`: a clock that steps back never sorts a later seq first. */
  readonly createdAt: number
}

/** Takes the next number. The caller holds the transaction the outbox row is written in. */
export function takeOutboxSeq(sql: SqlStorage, nowMs: number): TakenOutboxSeq {
  const [row] = sql
    .exec(
      `INSERT INTO ${HERA_OUTBOX_SEQ_TABLE} (id, seq, created_at) VALUES (1, 1, ?)
       ON CONFLICT(id) DO UPDATE SET seq = seq + 1, created_at = max(created_at, excluded.created_at)
       RETURNING seq, created_at`,
      nowMs
    )
    .toArray() as Array<{ seq: number; created_at: number }>
  if (row === undefined) {
    throw new Error("The outbox sequence upsert returned no row")
  }
  return { seq: Number(row.seq), createdAt: Number(row.created_at) }
}

export function orderedOutboxId(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(ORDERED_ID_WIDTH, "0")}`
}

/**
 * One statement that raises the sequence to `expr` and never lowers it, for a migration that
 * moves an existing counter onto the outbox (`"(SELECT seq FROM my_seq WHERE id = 1)"`) or a
 * restore that skipped Hera's tables (`"?"` with the restored number as its parameter). `expr`
 * is an SQL scalar written in the caller's code, never input; an empty source reads as 0.
 */
export function seedSequenceSql(expr: string): string {
  return `INSERT INTO ${HERA_OUTBOX_SEQ_TABLE} (id, seq, created_at)
    SELECT 1, coalesce(${expr}, 0), 0 WHERE true
    ON CONFLICT(id) DO UPDATE SET seq = max(seq, excluded.seq)`
}
