import type { HeraTenantDurableObjectOptions } from "../types.js"
import { DEFAULT_OUTBOX_BATCH_SIZE, DEFAULT_OUTBOX_MAX_ATTEMPTS } from "./schema.js"
import type { HeraOutboxBackoffOptions, HeraOutboxOrdering } from "./types.js"

/** An object's resolved outbox settings: every option with its default applied. */
export interface HeraOutboxSettings {
  readonly batchSize: number
  readonly backoff: HeraOutboxBackoffOptions
  readonly ordering: HeraOutboxOrdering
  readonly maxAttempts: number
}

export function resolveOutboxSettings(
  options: HeraTenantDurableObjectOptions | undefined
): HeraOutboxSettings {
  const maxAttempts = options?.outboxMaxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS
  return {
    batchSize: Math.max(1, options?.outboxBatchSize ?? DEFAULT_OUTBOX_BATCH_SIZE),
    backoff: options?.outboxBackoff ?? {},
    ordering: options?.outboxOrdering ?? "strict",
    maxAttempts: Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : DEFAULT_OUTBOX_MAX_ATTEMPTS,
  }
}
