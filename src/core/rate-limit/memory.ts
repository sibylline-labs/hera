import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type { HeraError } from "../errors/index.js"
import { fn } from "../fn/index.js"
import {
  assertSpendable,
  type HeraBucket,
  type HeraBucketLimit,
  makeTokenBucket,
} from "./bucket.js"
import { rateLimitedAfter } from "./refusal.js"

/**
 * One bucket held in memory and timed by the Effect `Clock` (`HeraRateLimit.memory`).
 *
 * Invariant: the bucket is never stored, so a restarted isolate or evicted object starts it full.
 * Use `HeraRateLimit.sqlStore` for a budget that must survive a restart.
 */
export interface HeraMemoryRateLimiter {
  readonly limit: HeraBucketLimit
  /** Admits a spend of `tokens` (default 1) and takes them, or fails `rate_limited` and takes
   *  nothing. Dies with `RangeError` for a spend larger than `capacity`, which never admits. */
  readonly take: (tokens?: number) => Effect.Effect<void, HeraError>
}

export function makeMemoryRateLimiter(
  limit: HeraBucketLimit
): HeraMemoryRateLimiter {
  const bucket = makeTokenBucket(limit)
  let held: HeraBucket | undefined
  // Read, refill, decide and write in one synchronous step, so two fibers never both spend the
  // last token.
  const spend = (tokens: number, now: number): number => {
    assertSpendable(bucket.limit, tokens)
    const current = bucket.refill(held, now)
    const wait = bucket.waitMs(current, tokens)
    if (wait === 0) held = bucket.take(current, tokens)
    return wait
  }
  return {
    limit: bucket.limit,
    take: fn("HeraRateLimit.memory.take")(function* (tokens: number = 1) {
      const now = yield* Clock.currentTimeMillis
      const wait = yield* Effect.sync(() => spend(tokens, now))
      if (wait > 0) return yield* Effect.fail(rateLimitedAfter(wait))
    }),
  }
}
