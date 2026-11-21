import { HERA_JOBS_DDL } from "../jobs/store.js"
import {
  type HeraOutboxBackoffOptions,
  type HeraOutboxRecord,
} from "../types.js"

export const DEFAULT_OUTBOX_BASE_DELAY_MS = 1_000
export const DEFAULT_OUTBOX_MAX_DELAY_MS = 300_000
export const DEFAULT_OUTBOX_BATCH_SIZE = 100
/** About an hour of capped backoff at the defaults (1+2+…+256 s, then 300 s steps). */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 20
export const DEFAULT_ALARM_ERROR_BACKOFF_MS = 30_000
export const DOMAIN_ALARM_META_KEY = "_hera_domain_alarm_at"

export const HERA_INTERNAL_DDL = [
  `CREATE TABLE IF NOT EXISTS _hera_migrations (
    version INTEGER NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _hera_outbox (
    id TEXT NOT NULL PRIMARY KEY,
    org_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    request_id TEXT,
    traceparent TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hera_outbox_due ON _hera_outbox (next_attempt_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS _hera_outbox_dead_letter (
    id TEXT NOT NULL PRIMARY KEY,
    org_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    request_id TEXT,
    traceparent TEXT,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    dead_lettered_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _hera_alarm_meta (
    key TEXT NOT NULL PRIMARY KEY,
    value_int INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  HERA_JOBS_DDL,
] as const

export interface RawOutboxSqlRow {
  readonly id: string
  readonly org_id: string
  readonly event_type: string
  readonly payload_json: string
  readonly request_id: string | null
  /** NULL on a row written before the column existed. */
  readonly traceparent?: string | null
  readonly attempts: number
  readonly next_attempt_at: number
  readonly last_error: string | null
  readonly created_at: number
}

export function coerceOutboxRow(row: RawOutboxSqlRow): HeraOutboxRecord<string> {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    type: String(row.event_type),
    eventType: String(row.event_type),
    payload: JSON.parse(String(row.payload_json)),
    payloadJson: String(row.payload_json),
    requestId: row.request_id === null ? null : String(row.request_id),
    ...(typeof row.traceparent === "string" ? { traceparent: row.traceparent } : {}),
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: Number(row.created_at),
  }
}

let outboxCounter = 0
export function generateOutboxEventId(nowMs: number): string {
  outboxCounter = (outboxCounter + 1) % 1_000_000
  const timePart = nowMs.toString(36).padStart(9, "0")
  const randPart = Math.random().toString(36).slice(2, 10)
  const seqPart = outboxCounter.toString(36).padStart(4, "0")
  return `outbox_${timePart}_${seqPart}_${randPart}`
}

/**
 * Computes exponential backoff with optional bounded jitter for failed outbox flushes.
 */
export function computeOutboxBackoffMs(
  attempts: number,
  options?: HeraOutboxBackoffOptions
): number {
  const baseDelayMs = Math.max(
    1,
    options?.baseDelayMs ?? DEFAULT_OUTBOX_BASE_DELAY_MS
  )
  const maxDelayMs = Math.max(
    baseDelayMs,
    options?.maxDelayMs ?? DEFAULT_OUTBOX_MAX_DELAY_MS
  )
  const exponent = Math.max(0, Math.min(20, Math.floor(attempts) - 1))
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent)
  const jitterRatio = Math.max(0, Math.min(1, options?.jitterRatio ?? 0))
  if (jitterRatio === 0) {
    return exponential
  }
  const rand = (options?.random ?? Math.random)()
  const jitterFactor = 1 + (rand * 2 - 1) * jitterRatio
  return Math.max(1, Math.min(maxDelayMs, Math.round(exponential * jitterFactor)))
}
