import {
  assertSpendable,
  type HeraBucket,
  type HeraBucketLimit,
  makeTokenBucket,
} from "./bucket.js"

/**
 * A map of token buckets keyed by string, all bound to one limit, holding at most `maxKeys` keys.
 * Pure: every function takes the clock as an argument, and the caller owns the decision.
 *
 * Invariant: the map never holds more than `maxKeys` keys. A bucket that has refilled to capacity
 * is the same as an absent one, so a new key that meets the cap first drops those; if that frees
 * no room, the new key is refused with the wait until the soonest held bucket is full. A key
 * already held is never refused for room. The map lives in memory and is never stored.
 */

export interface HeraKeyedBucketsOptions {
  /** The most keys the map holds at once: a positive safe integer. */
  readonly maxKeys: number
}

/** `read`'s answer: the key's bucket as of `now`, or no room for a key the map does not hold. */
export type HeraKeyedBucketRead =
  | { readonly kind: "bucket"; readonly bucket: HeraBucket }
  | { readonly kind: "full"; readonly waitMs: number }

/** A refused `spend`: the key's own bucket is short (`key`), or the map has no room for it (`full`). */
export interface HeraKeyedRefusal {
  readonly reason: "key" | "full"
  readonly waitMs: number
}

/** The keyed, bounded map (`HeraRateLimit.keyed`). */
export interface HeraKeyedBuckets {
  readonly limit: HeraBucketLimit
  readonly maxKeys: number
  /** How many keys hold a bucket. */
  readonly size: () => number
  /** `key`'s bucket refilled to `now` (full when never held); stores nothing. For a key not held
   *  while the map is at `maxKeys`, drops every bucket refilled to capacity first, and answers
   *  `full` when that frees no room. Run the `write` that follows in the same synchronous step:
   *  another key written in between can fill the cap. */
  readonly read: (key: string, now: number) => HeraKeyedBucketRead
  /** Stores `bucket` under `key`. Throws `RangeError` when `key` is not held and the map is at
   *  `maxKeys`. */
  readonly write: (key: string, bucket: HeraBucket) => void
  readonly waitMs: (bucket: HeraBucket, tokens?: number) => number
  readonly take: (bucket: HeraBucket, tokens?: number) => HeraBucket
  /** Admits a spend of `tokens` (default 1) from `key` and takes them: null. Otherwise the refusal,
   *  and nothing is taken. Throws `RangeError` for a spend larger than `capacity`. */
  readonly spend: (key: string, now: number, tokens?: number) => HeraKeyedRefusal | null
}

export function makeKeyedBuckets(
  limit: HeraBucketLimit,
  options: HeraKeyedBucketsOptions
): HeraKeyedBuckets {
  const bucket = makeTokenBucket(limit)
  const { maxKeys } = options
  if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
    throw new RangeError("HeraRateLimit: maxKeys must be a positive safe integer")
  }
  const held = new Map<string, HeraBucket>()

  // Drops every bucket refilled to capacity; returns the wait until the soonest remaining one is.
  const reclaim = (now: number): number => {
    let soonest = Number.POSITIVE_INFINITY
    for (const [key, stored] of held) {
      const current = bucket.refill(stored, now)
      if (current.tokens >= bucket.limit.capacity) held.delete(key)
      else soonest = Math.min(soonest, bucket.waitMs(current, bucket.limit.capacity))
    }
    return soonest
  }

  const read = (key: string, now: number): HeraKeyedBucketRead => {
    const stored = held.get(key)
    if (stored === undefined && held.size >= maxKeys) {
      const soonest = reclaim(now)
      if (held.size >= maxKeys) return { kind: "full", waitMs: soonest }
    }
    return { kind: "bucket", bucket: bucket.refill(stored, now) }
  }

  const write = (key: string, next: HeraBucket): void => {
    if (!held.has(key) && held.size >= maxKeys) {
      throw new RangeError(`HeraRateLimit: the keyed map is at its cap (${maxKeys} keys)`)
    }
    held.set(key, next)
  }

  return {
    limit: bucket.limit,
    maxKeys,
    size: () => held.size,
    read,
    write,
    waitMs: bucket.waitMs,
    take: bucket.take,
    spend: (key, now, tokens = 1) => {
      assertSpendable(bucket.limit, tokens)
      const current = read(key, now)
      if (current.kind === "full") return { reason: "full", waitMs: current.waitMs }
      const wait = bucket.waitMs(current.bucket, tokens)
      if (wait > 0) return { reason: "key", waitMs: wait }
      write(key, bucket.take(current.bucket, tokens))
      return null
    },
  }
}
