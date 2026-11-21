import {
  makeKeyedBuckets,
  makeMemoryRateLimiter,
  makeTokenBucket,
  rateLimitedAfter,
} from "../../core/rate-limit/index.js"
import { binding } from "./binding.js"
import { sqlStore } from "./sql-store.js"

export {
  HERA_RATE_LIMIT_BINDING_UNAVAILABLE,
  type HeraRateLimitBinding,
  type HeraRateLimitBindingOptions,
} from "./binding.js"
export {
  HERA_RATE_LIMIT_TABLE,
  type HeraSqlRateLimitOptions,
} from "./sql-store.js"

/**
 * Token-bucket rate limiting. Every limiter refuses with `rate_limited` (429) and a
 * `retryAfter` of at least one whole second.
 *
 * - `bucket(limit)`: the pure `refill` / `waitMs` / `take` / `drained` arithmetic bound to a limit.
 * - `memory(limit)`: one in-memory bucket timed by the Effect `Clock`.
 * - `keyed(limit, { maxKeys })`: a map of in-memory buckets by key, capped at `maxKeys` keys,
 *   reclaiming buckets that have refilled to capacity.
 * - `sqlStore(tx, key, { ...limit, now })`: a bucket row in a tenant object's SQLite, spent inside
 *   `transactSync`; it survives eviction.
 * - `binding(env.X, key, options?)`: a Cloudflare `RateLimit` binding that fails open, or closed
 *   with `onUnavailable: "refuse"`.
 */
export const HeraRateLimit = {
  bucket: makeTokenBucket,
  memory: makeMemoryRateLimiter,
  keyed: makeKeyedBuckets,
  sqlStore,
  binding,
  refusal: rateLimitedAfter,
} as const
