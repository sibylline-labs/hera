import { HeraError } from "../errors/index.js"

/**
 * The refusal every Hera limiter raises: `rate_limited` (429) with `retryAfter` in whole seconds,
 * rounded up and never below 1, so a client that waits it out is admitted. It carries no `fields`:
 * a bucket key can hold an org id or a client address, and `fields` reach the wire. Throws
 * `RangeError` for a wait that is negative or not finite: no `Retry-After` can carry it.
 */
export function rateLimitedAfter(waitMs: number): HeraError {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError("HeraRateLimit: a refusal's wait must be a non-negative finite number")
  }
  return HeraError.rateLimited(undefined, {
    retryAfter: Math.max(1, Math.ceil(waitMs / 1000)),
  })
}
