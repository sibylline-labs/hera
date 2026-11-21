import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { HeraError, type HeraErrorCode } from "../../core/errors/index.js"
import { fn } from "../../core/fn/index.js"
import { HeraLoggerService } from "../../core/logger/index.js"
import { rateLimitedAfter } from "../../core/rate-limit/index.js"

/** The Cloudflare Workers `RateLimit` binding's shape; `env.X` of a `ratelimits` entry satisfies it. */
export interface HeraRateLimitBinding {
  readonly limit: (options: { key: string }) => Promise<{ success: boolean }>
}

interface HeraRateLimitBindingBaseOptions {
  /** `Retry-After` of a refusal: the binding's `simple.period` (10 or 60), default 60. */
  readonly retryAfterSeconds?: number | undefined
  /** The line an unavailable binding writes, default `hera.rate_limit.binding_unavailable`. */
  readonly logEvent?: string | undefined
}

/** Fail open (the default): an unavailable binding admits the call. */
interface HeraRateLimitBindingAdmitOptions extends HeraRateLimitBindingBaseOptions {
  readonly onUnavailable?: "admit" | undefined
  readonly code?: never
  readonly publicMessage?: never
}

/** Fail closed: an unavailable binding fails with `HeraError.serviceUnavailable` (503). */
interface HeraRateLimitBindingRefuseOptions extends HeraRateLimitBindingBaseOptions {
  readonly onUnavailable: "refuse"
  /** The refusal's code, default `service_unavailable`. */
  readonly code?: HeraErrorCode | undefined
  /** The refusal's public message, default the catalog's `Service unavailable`. */
  readonly publicMessage?: string | undefined
}

export type HeraRateLimitBindingOptions =
  | HeraRateLimitBindingAdmitOptions
  | HeraRateLimitBindingRefuseOptions

export const HERA_RATE_LIMIT_BINDING_UNAVAILABLE =
  "hera.rate_limit.binding_unavailable"

const DEFAULT_PERIOD_SECONDS = 60

/**
 * Counts `key` against a Cloudflare `RateLimit` binding (`HeraRateLimit.binding`). A binding that
 * throws, or is absent from `env`, writes one error line, through the ambient `HeraLoggerService` when
 * one is provided, then fails open (the call is admitted) or, with `onUnavailable: "refuse"`, fails
 * closed with a 503. The key is never logged: it can be a client address or an unauthenticated org
 * claim.
 */
export const binding: (
  limiter: HeraRateLimitBinding | undefined,
  key: string,
  options?: HeraRateLimitBindingOptions
) => Effect.Effect<void, HeraError> = fn("HeraRateLimit.binding")(function* (
  limiter: HeraRateLimitBinding | undefined,
  key: string,
  options?: HeraRateLimitBindingOptions
) {
  const outcome = yield* Effect.tryPromise(async () => {
    // Inside the try: a missing binding throws here, and takes the same unavailable path.
    return (await limiter!.limit({ key })).success
  }).pipe(Effect.result)
  if (outcome._tag === "Failure") {
    const event = options?.logEvent ?? HERA_RATE_LIMIT_BINDING_UNAVAILABLE
    const logger = yield* Effect.serviceOption(HeraLoggerService)
    if (Option.isSome(logger)) {
      yield* logger.value.error(event, { error: outcome.failure.cause })
    } else {
      yield* Effect.logError(event)
    }
    if (options?.onUnavailable === "refuse") {
      return yield* Effect.fail(
        HeraError.serviceUnavailable(options.publicMessage, { code: options.code })
      )
    }
    return
  }
  if (!outcome.success) {
    const seconds = options?.retryAfterSeconds ?? DEFAULT_PERIOD_SECONDS
    return yield* Effect.fail(rateLimitedAfter(seconds * 1000))
  }
})
