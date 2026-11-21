import * as Effect from "effect/Effect"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  Hera,
  HeraOutbox,
  type HeraOutboxQueueSinkOptions,
  type HeraOutboxRecord,
  type OutboxQueueBinding,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

const T0 = 1_700_000_000_000

type SentMessage = { readonly body: unknown; readonly contentType?: string | undefined }

function recordingQueue(failOnCall?: number) {
  const calls: Array<ReadonlyArray<SentMessage>> = []
  const queue: OutboxQueueBinding = {
    sendBatch: async (messages) => {
      if (failOnCall !== undefined && calls.length === failOnCall) {
        throw new Error("queue down")
      }
      calls.push([...messages])
    },
  }
  return { calls, queue }
}

function sinkDo(options: HeraOutboxQueueSinkOptions) {
  const logs: Array<Record<string, unknown>> = []
  class SinkDO extends Hera.TenantDurableObject.configure({
    service: "sink-test",
    migrations: [],
    outboxBatchSize: 500,
    outboxBackoff: { baseDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 },
    deliverOutboxBatch: HeraOutbox.queueSink(options),
  }) {}
  const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
  const tenantDo = new SinkDO(harness.state, {}, { sink: (_line, entry) => logs.push(entry) })
  return { tenantDo, logs }
}

function enqueue(
  tenantDo: { runWithTenantCtx: <A, E>(e: Effect.Effect<A, E, never>) => Promise<A> } & {
    db: InstanceType<typeof Hera.TenantDurableObject>["db"]
  },
  payloads: ReadonlyArray<unknown>
): Promise<ReadonlyArray<HeraOutboxRecord>> {
  return tenantDo.runWithTenantCtx(
    tenantDo.db.transactWithOutbox(function* (tx) {
      const records: Array<HeraOutboxRecord> = []
      for (const [index, payload] of payloads.entries()) {
        records.push(
          yield* tx.enqueueOutbox({ id: `evt-${String(index).padStart(4, "0")}`, type: "item.created@1", payload })
        )
      }
      return records
    })
  )
}

const bodySize = (body: unknown) => HeraOutbox.utf8Bytes(JSON.stringify(body))

describe("HeraOutbox.queueSink", () => {
  // admits: a default limit drifting from the published Cloudflare limits; the source is a web page, no type can check it
  it("defaults its limits to Cloudflare Queues' published limits", () => {
    expect(HeraOutbox.QUEUE_LIMITS).toEqual({
      maxMessages: 100,
      maxBatchBytes: 256_000,
      maxMessageBytes: 128_000,
      metadataBytes: 100,
    })
  })

  // admits: sizing by String.length under-counts non-ASCII bodies past the queue limit; runtime encoding
  it("measures UTF-8 bytes, not UTF-16 units", () => {
    expect(HeraOutbox.utf8Bytes("é")).toBe(2)
    expect(HeraOutbox.utf8Bytes("😀")).toBe(4)
  })

  // admits: a batch over the message-count limit is one sendBatch call
  it("splits a batch over the message-count limit into compliant sends, in order", async () => {
    const { calls, queue } = recordingQueue()
    const { tenantDo } = sinkDo({ binding: queue, limits: { maxMessages: 3 } })
    const payloads = Array.from({ length: 7 }, (_, i) => ({ i }))
    await enqueue(tenantDo, payloads)

    const result = await Effect.runPromise(tenantDo.drainOutbox())
    expect(result).toMatchObject({ drained: 7, failed: 0, remaining: 0 })
    expect(calls.map((call) => call.length)).toEqual([3, 3, 1])
    expect(calls.flat().map((m) => m.body)).toEqual(payloads)
  })

  // admits: a batch over the byte limit is one sendBatch call
  it("splits a batch over the byte limit into compliant sends", async () => {
    const { calls, queue } = recordingQueue()
    const payloads = Array.from({ length: 5 }, (_, i) => ({ i, pad: "x".repeat(40) }))
    const each = bodySize(payloads[0]) + 10
    const { tenantDo } = sinkDo({
      binding: queue,
      limits: { maxBatchBytes: each * 2, maxMessageBytes: each * 2, metadataBytes: 10 },
    })
    await enqueue(tenantDo, payloads)

    await Effect.runPromise(tenantDo.drainOutbox())
    expect(calls.map((call) => call.length)).toEqual([2, 2, 1])
    expect(calls.flat().map((m) => m.body)).toEqual(payloads)
  })

  // admits: an oversize event stalls the stream behind it
  it("rejects an oversize message to onOversize, acks it, logs at error, and sends the rest", async () => {
    const { calls, queue } = recordingQueue()
    const rejected: Array<{ id: string; bytes: number; limit: number }> = []
    const secret = "s".repeat(500)
    const { tenantDo, logs } = sinkDo({
      binding: queue,
      limits: { maxMessageBytes: 200 },
      onOversize: ({ record, bytes, limit }) =>
        Effect.sync(() => {
          rejected.push({ id: record.id, bytes, limit })
        }),
    })
    await enqueue(tenantDo, [{ n: 1 }, { secret }, { n: 3 }])

    const result = await Effect.runPromise(tenantDo.drainOutbox())
    expect(result).toMatchObject({ drained: 3, failed: 0, remaining: 0 })
    expect(calls.flat().map((m) => m.body)).toEqual([{ n: 1 }, { n: 3 }])
    expect(rejected).toEqual([
      { id: "evt-0001", bytes: bodySize({ secret }) + 100, limit: 200 },
    ])
    const entry = logs.find((log) => log.msg === "hera.outbox.event_rejected")
    expect(entry).toMatchObject({ level: "error", outboxId: "evt-0001", type: "item.created@1", limit: 200 })
    expect(JSON.stringify(entry)).not.toContain(secret)
  })

  // admits: a throwing onOversize hook stalls the stream it exists to unblock; runtime control flow
  it("does not let a failing onOversize block the batch", async () => {
    const { calls, queue } = recordingQueue()
    const { tenantDo, logs } = sinkDo({
      binding: queue,
      limits: { maxMessageBytes: 150 },
      onOversize: () => Promise.reject(new Error("hook down")),
    })
    await enqueue(tenantDo, [{ big: "b".repeat(300) }, { n: 2 }])

    const result = await Effect.runPromise(tenantDo.drainOutbox())
    expect(result).toMatchObject({ drained: 2, failed: 0 })
    expect(calls.flat().map((m) => m.body)).toEqual([{ n: 2 }])
    expect(logs.some((log) => log.msg === "hera.outbox.on_oversize_failed")).toBe(true)
  })

  // admits: encode output (body, contentType) dropped on the way to sendBatch; runtime data path
  it("sends the encoded body and contentType", async () => {
    const { calls, queue } = recordingQueue()
    const { tenantDo } = sinkDo({
      binding: queue,
      encode: (record) =>
        Effect.succeed({ body: { wrapped: record.payload }, bytes: 1, contentType: "json" as const }),
    })
    await enqueue(tenantDo, [{ n: 1 }])

    await Effect.runPromise(tenantDo.drainOutbox())
    expect(calls).toEqual([[{ body: { wrapped: { n: 1 } }, contentType: "json" }]])
  })

  // admits: a configure()-time sink that cannot reach env.EVENTS; options are static, env arrives later
  it("resolves the binding from env, defaulting to env.EVENTS", async () => {
    const { calls, queue } = recordingQueue()
    class EnvDO extends Hera.TenantDurableObject.configure({
      service: "sink-env-test",
      migrations: [],
      deliverOutboxBatch: HeraOutbox.queueSink(),
    }) {}
    const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
    const tenantDo = new EnvDO(harness.state, { EVENTS: queue })
    await enqueue(tenantDo, [{ n: 1 }])

    await Effect.runPromise(tenantDo.drainOutbox())
    expect(calls).toEqual([[{ body: { n: 1 } }]])
  })

  // admits: a failed send acking rows it never delivered; drain ack semantics are runtime
  it("fails the batch, keeping every row, when the binding is absent or a send rejects", async () => {
    const { tenantDo: unbound } = sinkDo({ binding: () => undefined })
    await enqueue(unbound, [{ n: 1 }])
    expect(await Effect.runPromise(unbound.drainOutbox())).toMatchObject({ drained: 0, failed: 1, remaining: 1 })

    const { calls, queue } = recordingQueue(1)
    const { tenantDo } = sinkDo({ binding: queue, limits: { maxMessages: 1 } })
    await enqueue(tenantDo, [{ n: 1 }, { n: 2 }])
    expect(await Effect.runPromise(tenantDo.drainOutbox())).toMatchObject({ drained: 0, failed: 2, remaining: 2 })
    expect(calls.flat().map((m) => m.body)).toEqual([{ n: 1 }])
  })

  // admits: a chunk planner that overfills a batch for some size mix; arithmetic over arbitrary inputs
  it("never plans a send over the count or byte limit, and loses or reorders nothing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 60 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 100, max: 1_000 }),
        (sizes, maxMessages, maxBatchBytes) => {
          const limits = { maxMessages, maxBatchBytes, maxMessageBytes: 300, metadataBytes: 7 }
          const items = sizes.map((bytes, index) => ({ index, bytes }))
          const plan = HeraOutbox.planQueueSends(items, limits)
          for (const batch of plan.batches) {
            expect(batch.length).toBeGreaterThan(0)
            expect(batch.length).toBeLessThanOrEqual(maxMessages)
            const total = batch.reduce((sum, item) => sum + item.bytes + limits.metadataBytes, 0)
            expect(total).toBeLessThanOrEqual(maxBatchBytes)
          }
          for (const item of plan.oversize) {
            expect(item.bytes + limits.metadataBytes).toBeGreaterThan(Math.min(limits.maxMessageBytes, maxBatchBytes))
          }
          const sent = plan.batches.flat().map((item) => item.index)
          expect(sent).toEqual([...sent].sort((a, b) => a - b))
          expect(sent.length + plan.oversize.length).toBe(items.length)
        }
      )
    )
  })
})
