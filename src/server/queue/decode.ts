import type * as Schema from "effect/Schema"
import { HeraSchema } from "../../core/schema/index.js"
import type {
  HeraQueueBatch,
  HeraQueueBatchInput,
  HeraQueueDecodeIssue,
  HeraQueueInvalidMessage,
  HeraQueueMessage,
} from "./types.js"
import { unwrapTraceEnvelope } from "./trace-envelope.js"

const issueKey = (key: PropertyKey): string | number =>
  typeof key === "symbol" ? String(key) : key

/**
 * Splits a batch into decoded messages and invalid ones. Total: a body that fails decode is
 * moved to `invalid` with its structural issues, never failing the batch.
 */
export function decodeQueueBatch<A>(
  schema: Schema.Top | undefined,
  input: HeraQueueBatchInput
): HeraQueueBatch<A> {
  const messages: Array<HeraQueueMessage<A>> = []
  const invalid: Array<HeraQueueInvalidMessage> = []
  for (const message of input.messages) {
    const { body, ...trace } = unwrapTraceEnvelope(message.body)
    const meta = { id: message.id, timestamp: message.timestamp, attempts: message.attempts, ...trace }
    if (schema === undefined) {
      messages.push({ ...meta, body: body as A })
      continue
    }
    const result = HeraSchema.decodeResult(schema, body)
    if (result._tag === "Success") {
      messages.push({ ...meta, body: result.success as A })
      continue
    }
    const issues: Array<HeraQueueDecodeIssue> = result.failure.issues.map((issue) => ({
      path: issue.path.map(issueKey),
      code: issue.code,
    }))
    invalid.push({ ...meta, body, issues })
  }
  return { queue: input.queue, messages, invalid }
}
