import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  Hera,
  HeraCtx,
  HeraOutbox,
  type HeraOutboxRecord,
  type HeraQueueBatchInput,
  type OutboxQueueBinding,
} from "../src/index"
import { createHeraLogger } from "../src/core/logger/index"

// A traced outbox body crosses the queue with its producer's trace context,
// and the consumer links its batch span to each producer span.
const TRACE_A = "0af7651916cd43dd8448eb211c80319c"
const TRACE_B = "1bf7651916cd43dd8448eb211c80319d"
const SPAN = "b7ad6b7169203331"
const REQ = "req_01JAW4B8X7H2M9Q5R8T3V6Y1Z0"
const Event = Schema.Struct({ n: Schema.Number })

function record(id: string, extra: Partial<HeraOutboxRecord> = {}): HeraOutboxRecord {
  const payload = { n: 1 }
  return {
    id,
    orgId: "org_01JAW4B8X7H2M9Q5R8T3V6Y1Z0" as HeraOutboxRecord["orgId"],
    type: "test.event@1",
    eventType: "test.event@1",
    payload,
    payloadJson: JSON.stringify(payload),
    requestId: null,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: 0,
    ...extra,
  }
}

async function send(records: ReadonlyArray<HeraOutboxRecord>, trace: boolean): Promise<ReadonlyArray<unknown>> {
  const bodies: Array<unknown> = []
  const binding: OutboxQueueBinding = {
    sendBatch: async (messages) => void bodies.push(...[...messages].map((m) => m.body)),
  }
  const sink = HeraOutbox.queueSink({ trace, binding })
  const result = sink(records, { env: {}, orgId: records[0]!.orgId, logger: createHeraLogger({ service: "t" }) })
  await Effect.runPromise(result as Effect.Effect<unknown, unknown, never>)
  return bodies
}

function batchOf(bodies: ReadonlyArray<unknown>): HeraQueueBatchInput {
  return {
    queue: "events",
    messages: bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(0), attempts: 1, body })),
    ackAll: () => undefined,
    retryAll: () => undefined,
  }
}

async function consume(bodies: ReadonlyArray<unknown>) {
  const seen: Array<unknown> = []
  const consumer = Hera.queueConsumer({
    name: "Events.consume",
    schema: Event,
    handler: (batch) =>
      Effect.gen(function* () {
        const span = yield* Effect.orDie(Effect.currentSpan)
        const ctx = yield* HeraCtx
        seen.push({ links: span.links, requestId: ctx.requestId, batch })
      }),
  })
  await consumer(batchOf(bodies), {})
  return seen[0] as {
    readonly links: ReadonlyArray<{ readonly span: { readonly traceId: string } }>
    readonly requestId: string
    readonly batch: { readonly messages: ReadonlyArray<{ readonly body: unknown; readonly traceparent?: string; readonly requestId?: string }> }
  }
}

describe("traced outbox queue bodies", () => {
  // admits: the wire body of a queue message is runtime data
  it("queueSink({ trace: true }) wraps a record that carries a traceparent; the default keeps the bare payload", async () => {
    const r = record("e1", { traceparent: `00-${TRACE_A}-${SPAN}-01`, requestId: REQ })
    expect(await send([r], false)).toEqual([{ n: 1 }])
    expect(await send([r], true)).toEqual([
      { __heraTrace: { v: 1, traceparent: `00-${TRACE_A}-${SPAN}-01`, requestId: REQ }, payload: { n: 1 } },
    ])
    expect(await send([record("e2")], true)).toEqual([{ n: 1 }])
  })

  // admits: links and request id adoption are runtime span state
  it("the consumer unwraps before decode, links each producer span and adopts a shared request id", async () => {
    const bodies = await send(
      [
        record("e1", { traceparent: `00-${TRACE_A}-${SPAN}-01`, requestId: REQ }),
        record("e2", { traceparent: `00-${TRACE_B}-${SPAN}-01`, requestId: REQ }),
      ],
      true
    )
    const seen = await consume(bodies)
    expect(seen.batch.messages.map((m) => m.body)).toEqual([{ n: 1 }, { n: 1 }])
    expect(seen.links.map((l) => l.span.traceId)).toEqual([TRACE_A, TRACE_B])
    expect(seen.requestId).toBe(REQ)
    expect(seen.batch.messages[0]?.traceparent).toBe(`00-${TRACE_A}-${SPAN}-01`)
  })

  // admits: mixed producers are a runtime property of one batch
  it("mixed request ids mint a fresh one; bare and malformed envelopes add no link", async () => {
    const seen = await consume([
      { __heraTrace: { v: 1, traceparent: `00-${TRACE_A}-${SPAN}-01`, requestId: REQ }, payload: { n: 1 } },
      { __heraTrace: { v: 1, requestId: "req_01JAW4B8X7H2M9Q5R8T3V6Y1Z9" }, payload: { n: 2 } },
      { __heraTrace: { v: 1, traceparent: "garbage" }, payload: { n: 3 } },
      { n: 4 },
    ])
    expect(seen.links.map((l) => l.span.traceId)).toEqual([TRACE_A])
    expect(seen.requestId).not.toBe(REQ)
    expect(seen.batch.messages.map((m) => m.body)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }])
    expect(seen.batch.messages[2]?.traceparent).toBeUndefined()
  })
})
