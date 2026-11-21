/**
 * Token-bucket arithmetic, with a `tokens` argument for weighted takes. Pure: every function takes the clock as an argument, and the caller owns the
 * storage and the decision.
 *
 * A bucket holds `tokens`, refilled continuously at `refillPerSecond` up to `capacity`, as of
 * `updatedAt`. `tokens` may be negative: a drained bucket owes its debt back before it admits again.
 */

export interface HeraBucketLimit {
  /** The most a bucket holds, and so the longest burst an idle key can spend. */
  readonly capacity: number
  readonly refillPerSecond: number
}

export interface HeraBucket {
  readonly tokens: number
  /** Epoch milliseconds the `tokens` figure is as of. */
  readonly updatedAt: number
}

/** `bucket` as of `now`. A bucket never held is full. The stamp never moves backwards, so a clock
 *  that reads earlier than it (a skewed reading) neither adds nor removes tokens. */
export function refillBucket(
  bucket: HeraBucket | undefined,
  limit: HeraBucketLimit,
  now: number
): HeraBucket {
  if (bucket === undefined) return { tokens: limit.capacity, updatedAt: now }
  const elapsedMs = Math.max(0, now - bucket.updatedAt)
  return {
    tokens: Math.min(
      limit.capacity,
      bucket.tokens + (elapsedMs * limit.refillPerSecond) / 1000
    ),
    updatedAt: Math.max(bucket.updatedAt, now),
  }
}

/** Milliseconds until `bucket` holds `tokens`: zero when it already does, rounded up otherwise, so a
 *  caller that waits this long is admitted. */
export function bucketWaitMs(
  bucket: HeraBucket,
  limit: HeraBucketLimit,
  tokens = 1
): number {
  if (bucket.tokens >= tokens) return 0
  return Math.ceil(((tokens - bucket.tokens) * 1000) / limit.refillPerSecond)
}

/** `bucket` after a request of `tokens` is admitted. */
export function takeFromBucket(bucket: HeraBucket, tokens = 1): HeraBucket {
  return { tokens: bucket.tokens - tokens, updatedAt: bucket.updatedAt }
}

/** A bucket stamped `now` whose next token arrives exactly `retryAfterSeconds` later, for whole
 *  seconds; a fractional wait can land a float rounding short of one token. */
export function drainedBucket(
  limit: HeraBucketLimit,
  retryAfterSeconds: number,
  now: number
): HeraBucket {
  return { tokens: 1 - retryAfterSeconds * limit.refillPerSecond, updatedAt: now }
}

/** Throws `RangeError` unless `capacity` and `refillPerSecond` are finite and positive. */
export function assertBucketLimit(limit: HeraBucketLimit): void {
  for (const [name, value] of [
    ["capacity", limit.capacity],
    ["refillPerSecond", limit.refillPerSecond],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`HeraRateLimit: ${name} must be a positive finite number`)
    }
  }
}

/** Throws `RangeError` for a spend that can never be admitted: not a positive finite count, or more
 *  than `capacity`. */
export function assertSpendable(limit: HeraBucketLimit, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0 || tokens > limit.capacity) {
    throw new RangeError(
      `HeraRateLimit: a spend must be positive and at most capacity (${limit.capacity})`
    )
  }
}

/** The pure bucket operations bound to one limit (`HeraRateLimit.bucket`). */
export interface HeraTokenBucket {
  readonly limit: HeraBucketLimit
  readonly refill: (bucket: HeraBucket | undefined, now: number) => HeraBucket
  readonly waitMs: (bucket: HeraBucket, tokens?: number) => number
  readonly take: (bucket: HeraBucket, tokens?: number) => HeraBucket
  readonly drained: (retryAfterSeconds: number, now: number) => HeraBucket
}

export function makeTokenBucket(limit: HeraBucketLimit): HeraTokenBucket {
  assertBucketLimit(limit)
  const bound: HeraBucketLimit = {
    capacity: limit.capacity,
    refillPerSecond: limit.refillPerSecond,
  }
  return {
    limit: bound,
    refill: (bucket, now) => refillBucket(bucket, bound, now),
    waitMs: (bucket, tokens) => bucketWaitMs(bucket, bound, tokens),
    take: (bucket, tokens) => takeFromBucket(bucket, tokens),
    drained: (retryAfterSeconds, now) =>
      drainedBucket(bound, retryAfterSeconds, now),
  }
}
