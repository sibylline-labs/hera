import type { HeraError } from "../../core/errors/index.js"
import {
  assertSpendable,
  type HeraBucket,
  type HeraBucketLimit,
  makeTokenBucket,
  rateLimitedAfter,
} from "../../core/rate-limit/index.js"
import type { HeraSqlError, HeraSyncTx, SyncEffect } from "../durable-object/types.js"

/** The table `sqlStore` keeps its buckets in unless the caller names another. */
export const HERA_RATE_LIMIT_TABLE = "hera_rate_limit_buckets"

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface HeraSqlRateLimitOptions extends HeraBucketLimit {
  /** Epoch milliseconds of the decision: the Durable Object's clock (`this.now()`). `Clock` inside
   *  `transactSync` is wall time, not the object's, so the store never reads it. */
  readonly now: number
  /** Tokens to spend, default 1. More than `capacity` never admits and dies with `RangeError`. */
  readonly tokens?: number | undefined
  /** Table holding the buckets (`key TEXT PRIMARY KEY, tokens REAL, updated_at INTEGER`), default
   *  `hera_rate_limit_buckets`. A table already in that shape keeps its rows. */
  readonly table?: string | undefined
}

/**
 * Spends from the bucket stored under `key` in the tenant object's SQLite (`HeraRateLimit.sqlStore`).
 * Runs inside the caller's `transactSync`: the read and the write are one step no other call
 * interleaves with, a refusal fails the transaction so nothing is written, and two keys spent in one
 * transaction are admitted together or not at all. The bucket survives eviction.
 */
export function sqlStore(
  tx: HeraSyncTx,
  key: string,
  options: HeraSqlRateLimitOptions
): SyncEffect<void, HeraError | HeraSqlError> {
  const tokens = options.tokens ?? 1
  const table = options.table ?? HERA_RATE_LIMIT_TABLE
  return tx.gen(function* () {
    const bucket = yield* tx.sync(() => {
      const checked = makeTokenBucket(options)
      assertSpendable(checked.limit, tokens)
      if (!Number.isFinite(options.now)) {
        throw new RangeError("HeraRateLimit.sqlStore: now must be finite epoch milliseconds")
      }
      if (!TABLE_NAME_RE.test(table)) {
        throw new RangeError("HeraRateLimit.sqlStore: table must be a plain SQL identifier")
      }
      return checked
    })
    yield* tx.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (key TEXT NOT NULL PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL)`
    )
    const rows = yield* tx.query<{ tokens: number; updated_at: number }>(
      `SELECT tokens, updated_at FROM ${table} WHERE key = ?`,
      [key]
    )
    const stored: HeraBucket | undefined =
      rows[0] === undefined
        ? undefined
        : { tokens: Number(rows[0].tokens), updatedAt: Number(rows[0].updated_at) }
    const current = bucket.refill(stored, options.now)
    const wait = bucket.waitMs(current, tokens)
    if (wait > 0) return yield* tx.fail(rateLimitedAfter(wait))
    const next = bucket.take(current, tokens)
    yield* tx.exec(
      `INSERT INTO ${table} (key, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
      [key, next.tokens, next.updatedAt]
    )
  })
}
