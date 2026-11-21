import * as Effect from "effect/Effect"
import * as Random from "effect/Random"
import { extractSafeDefectName } from "../routes/response.js"
import type { HeraRpcRetryBackoff, HeraRpcRetryPolicy } from "./types.js"

const RETRYABLE_WORKERD_PATTERNS = [
  "network connection lost",
  "durable object reset",
  "cannot resolve durable object",
  "internal error in durable object storage",
  "disconnected",
]

const OVERLOADED_PATTERN = "overloaded"

type CloudflareErrorFlags = {
  readonly retryable?: unknown
  readonly overloaded?: unknown
  readonly remote?: unknown
}

/**
 * Checks whether a thrown `workerd` RPC transport rejection is transient/retryable, without
 * leaking the message. Cloudflare's flags decide first: `overloaded` is never retried (retrying
 * worsens the overload), `retryable` is, and `remote` (thrown by the callee's own code) is not.
 * @see https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 */
export function isRetryableTransportError(err: unknown): boolean {
  const flags: CloudflareErrorFlags =
    typeof err === "object" && err !== null ? err : {}
  const msg =
    err instanceof Error
      ? err.message.toLowerCase()
      : typeof err === "string"
        ? err.toLowerCase()
        : ""
  if (flags.overloaded === true || msg.includes(OVERLOADED_PATTERN)) {
    return false
  }
  if (flags.retryable === true) {
    return true
  }
  if (flags.remote === true) {
    return false
  }
  return RETRYABLE_WORKERD_PATTERNS.some((pattern) => msg.includes(pattern))
}

/** Default backoff for `retry`: full-jitter exponential from 50 ms, capped at 1 s. */
export const DEFAULT_RPC_RETRY_BACKOFF: HeraRpcRetryBackoff = {
  baseMs: 50,
  maxMs: 1000,
}

/** Full-jitter delay before retry `retryNumber` (1-based) for a uniform draw `u` in `[0, 1)`. */
export function rpcRetryBackoffMs(
  backoff: HeraRpcRetryBackoff,
  retryNumber: number,
  u: number
): number {
  const ceiling = backoff.baseMs * 2 ** (retryNumber - 1)
  return Math.max(0, Math.min(backoff.maxMs, ceiling * u))
}

export function normalizeAttempts(attempts: number | undefined): number {
  return attempts !== undefined && Number.isFinite(attempts) && attempts >= 1
    ? Math.floor(attempts)
    : 1
}

/** One failed attempt: the rejection (or timeout) and whether the policy allows another. */
export interface RpcTransportFailure {
  readonly cause: unknown
  readonly timedOut: boolean
  readonly retryable: boolean
}

export interface RpcTransportExhausted extends RpcTransportFailure {
  readonly attempts: number
}

/** Stands in for the rejection when an attempt is abandoned at `timeoutMs`. */
export class RpcAttemptTimeoutError extends Error {
  constructor(ms: number) {
    super(`rpc attempt timed out after ${ms}ms`)
    this.name = "RpcAttemptTimeoutError"
  }
}

/** Abandons `attempt` after `timeoutMs` (on the Effect `Clock`) as a retryable failure. */
export function withAttemptTimeout<A>(
  attempt: Effect.Effect<A, RpcTransportFailure>,
  timeoutMs: number | undefined
): Effect.Effect<A, RpcTransportFailure> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return attempt
  }
  return attempt.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail<RpcTransportFailure>({
          cause: new RpcAttemptTimeoutError(timeoutMs),
          timedOut: true,
          retryable: true,
        }),
    })
  )
}

/**
 * Runs `attempt(1..attempts)` until one succeeds, a failure is not retryable, or the policy is
 * exhausted; sleeps the full-jitter backoff between attempts. No policy: exactly one attempt.
 */
export function withRpcRetry<A>(
  attempt: (n: number) => Effect.Effect<A, RpcTransportFailure>,
  policy: HeraRpcRetryPolicy | undefined,
  site: { readonly service: string; readonly method: string }
): Effect.Effect<A, RpcTransportExhausted> {
  const maxAttempts = normalizeAttempts(policy?.attempts)
  const backoff = policy?.backoff ?? DEFAULT_RPC_RETRY_BACKOFF
  const run = (n: number): Effect.Effect<A, RpcTransportExhausted> =>
    attempt(n).pipe(
      Effect.catch((failure) => {
        if (n >= maxAttempts || !failure.retryable) {
          return Effect.fail({ ...failure, attempts: n })
        }
        return Effect.gen(function* () {
          const backoffMs = rpcRetryBackoffMs(backoff, n, yield* Random.next)
          policy?.onRetry?.({
            ...site,
            attempt: n,
            backoffMs,
            errorName: extractSafeDefectName(failure.cause),
            timedOut: failure.timedOut,
          })
          yield* Effect.sleep(backoffMs)
          return yield* run(n + 1)
        })
      })
    )
  return run(1)
}
