import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import { HeraError } from "../../core/errors/index.js"
import { extractSafeDefectName } from "../routes/response.js"
import type { HeraQueueError } from "./types.js"

/** Cloudflare Queues accepts a retry delay of 0 to 43200 seconds (12 hours). */
export const MAX_QUEUE_RETRY_DELAY_SECONDS = 43_200

export const DEFAULT_QUEUE_RETRY_DELAY_SECONDS = 30

export type HeraQueueSettlement =
  | { readonly kind: "ack" }
  | {
      readonly kind: "retry"
      readonly delaySeconds?: number | undefined
      readonly event: "hera.queue.batch_retry" | "hera.queue.batch_failed" | "hera.queue.batch_defect"
      readonly fields: Readonly<Record<string, unknown>>
    }

export function clampDelaySeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.min(Math.ceil(seconds), MAX_QUEUE_RETRY_DELAY_SECONDS)
}

/** Hera's retry convention: `fields.retryable === true` (`definedFields` on a defined error). */
export function isRetryableQueueError(error: HeraQueueError): boolean {
  const fields = HeraError.is(error) ? error.fields : error.definedFields
  return fields?.["retryable"] === true
}

/**
 * The batch outcome for a handler's exit: success acks; a retryable failure retries after its
 * `retryAfter` (else `defaultDelaySeconds`); any other failure, a defect or an interrupt retries
 * now, so the queue's `max_retries` routes it to the dead-letter queue rather than dropping it.
 */
export function settleQueueExit(
  exit: Exit.Exit<void, HeraQueueError>,
  defaultDelaySeconds: number
): HeraQueueSettlement {
  if (Exit.isSuccess(exit)) return { kind: "ack" }
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) {
    const error = failure.value
    if (isRetryableQueueError(error)) {
      const delaySeconds = clampDelaySeconds(error.retryAfter ?? defaultDelaySeconds)
      return {
        kind: "retry",
        delaySeconds,
        event: "hera.queue.batch_retry",
        fields: { code: error.code, delaySeconds },
      }
    }
    return { kind: "retry", event: "hera.queue.batch_failed", fields: { code: error.code } }
  }
  const defect = Cause.hasDies(exit.cause)
    ? extractSafeDefectName(Cause.squash(exit.cause))
    : "Interrupt"
  return { kind: "retry", event: "hera.queue.batch_defect", fields: { defect } }
}
