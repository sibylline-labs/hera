/**
 * What one Cloudflare Queues `sendBatch` call accepts
 * (https://developers.cloudflare.com/queues/platform/limits/): at most 100 messages or 256 KB in
 * total, 128 KB per message, and up to ~100 bytes of internal metadata per message that counts
 * towards both. 1 KB is 1000 bytes.
 */
export const QUEUE_LIMITS = {
  maxMessages: 100,
  maxBatchBytes: 256_000,
  maxMessageBytes: 128_000,
  metadataBytes: 100,
} as const

export interface HeraOutboxQueueLimits {
  readonly maxMessages: number
  readonly maxBatchBytes: number
  readonly maxMessageBytes: number
  /** Added to every message's encoded bytes before either byte limit is checked. */
  readonly metadataBytes: number
}

const encoder = new TextEncoder()

/** The UTF-8 bytes of `text`, which is what the queue measures (`String.length` counts UTF-16 units). */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength
}

export interface QueueSendPlan<Item> {
  /** Non-empty, in input order, each inside `maxMessages` and `maxBatchBytes`. */
  readonly batches: ReadonlyArray<ReadonlyArray<Item>>
  /** Items that cannot fit one message (or one batch), in input order. */
  readonly oversize: ReadonlyArray<Item>
}

/**
 * Split `items` into `sendBatch`-sized batches in order. An item whose `bytes + metadataBytes`
 * exceeds `maxMessageBytes` or `maxBatchBytes` can never be sent and goes to `oversize`.
 */
export function planQueueSends<Item extends { readonly bytes: number }>(
  items: ReadonlyArray<Item>,
  limits: HeraOutboxQueueLimits
): QueueSendPlan<Item> {
  const maxMessages = Math.max(1, limits.maxMessages)
  const singleLimit = Math.min(limits.maxMessageBytes, limits.maxBatchBytes)
  const batches: Array<Array<Item>> = []
  const oversize: Array<Item> = []
  let current: Array<Item> = []
  let currentBytes = 0
  for (const item of items) {
    const cost = item.bytes + limits.metadataBytes
    if (cost > singleLimit) {
      oversize.push(item)
      continue
    }
    if (current.length === maxMessages || currentBytes + cost > limits.maxBatchBytes) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(item)
    currentBytes += cost
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return { batches, oversize }
}
