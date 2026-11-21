import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  createHeraLogger,
  Hera,
  HeraCtx,
  HeraError,
  type HeraQueueBatch,
  type HeraQueueBatchInput,
  type LogEntry,
} from "../src/index"

const Event = Schema.Struct({ id: Schema.String, n: Schema.Number })

type Settled = { readonly kind: "ack" } | { readonly kind: "retry"; readonly options?: unknown }

function fakeBatch(bodies: ReadonlyArray<unknown>, overrides?: Partial<HeraQueueBatchInput>) {
  const settled: Array<Settled> = []
  const batch: HeraQueueBatchInput = {
    queue: "events-dev",
    messages: bodies.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(1_700_000_000_000),
      attempts: 1,
      body,
    })),
    ackAll: () => {
      settled.push({ kind: "ack" })
    },
    retryAll: (options) => {
      settled.push(options === undefined ? { kind: "retry" } : { kind: "retry", options })
    },
    ...overrides,
  }
  return { batch, settled }
}

function capturingLogger(throwOnWrite = false) {
  const lines: Array<LogEntry> = []
  const logger = createHeraLogger({
    service: "events",
    sink: (_line, entry) => {
      if (throwOnWrite) throw new Error("sink down")
      lines.push(entry)
    },
  })
  return { logger, lines }
}

const fail = (error: HeraError) => () => Effect.fail(error)

describe("Hera.queueConsumer", () => {
  // admits: a clean batch is acked exactly once with decoded bodies; ackAll is a runtime call no type sees.
  it("acks a fully valid batch once and hands the handler decoded bodies", async () => {
    const { logger, lines } = capturingLogger()
    let seen: HeraQueueBatch<{ readonly id: string; readonly n: number }> | undefined
    const consume = Hera.queueConsumer({
      name: "Events.archive",
      schema: Event,
      logger,
      handler: Hera.fn("Events.archive")(function* (
        batch: HeraQueueBatch<{ readonly id: string; readonly n: number }>
      ) {
        seen = batch
      }),
    })
    const { batch, settled } = fakeBatch([{ id: "a", n: 1 }, { id: "b", n: 2 }])
    await consume(batch, {})
    expect(settled).toEqual([{ kind: "ack" }])
    expect(seen?.messages.map((m) => m.body)).toEqual([{ id: "a", n: 1 }, { id: "b", n: 2 }])
    expect(seen?.invalid).toEqual([])
    expect(lines).toEqual([])
  })

  // admits: one bad body must not fail the batch or leak its value into a log line.
  it("routes one undecodable message to invalid without poisoning the rest", async () => {
    const { logger, lines } = capturingLogger()
    let seen: HeraQueueBatch<{ readonly id: string; readonly n: number }> | undefined
    const consume = Hera.queueConsumer({
      name: "Events.archive",
      schema: Event,
      logger,
      handler: (batch) => Effect.sync(() => void (seen = batch)),
    })
    const poison = { id: "secret-value-xyz", n: "not-a-number" }
    const { batch, settled } = fakeBatch([{ id: "a", n: 1 }, poison, { id: "c", n: 3 }])
    await consume(batch, {})

    expect(settled).toEqual([{ kind: "ack" }])
    expect(seen?.messages.map((m) => m.id)).toEqual(["m0", "m2"])
    expect(seen?.invalid).toHaveLength(1)
    expect(seen?.invalid[0]?.id).toBe("m1")
    expect(seen?.invalid[0]?.body).toBe(poison)
    expect(seen?.invalid[0]?.issues.map((i) => i.path)).toEqual([["n"]])

    expect(lines).toHaveLength(1)
    expect(lines[0]?.msg).toBe("hera.queue.message_invalid")
    expect(lines[0]?.["messageId"]).toBe("m1")
    expect(JSON.stringify(lines[0])).not.toContain("secret-value-xyz")
    expect(JSON.stringify(lines[0])).not.toContain("not-a-number")
  })

  // admits: a fields.retryable error retries with its retryAfter as the delay.
  it("retries a retryable HeraError after its retryAfter", async () => {
    const { logger, lines } = capturingLogger()
    const consume = Hera.queueConsumer({
      name: "Events.archive",
      logger,
      handler: fail(
        HeraError.serviceUnavailable("R2 down", { retryAfter: 120, fields: { retryable: true } })
      ),
    })
    const { batch, settled } = fakeBatch([{}])
    await consume(batch, {})
    expect(settled).toEqual([{ kind: "retry", options: { delaySeconds: 120 } }])
    expect(lines.map((l) => [l.level, l.msg])).toEqual([["warn", "hera.queue.batch_retry"]])
    expect(lines[0]?.["delaySeconds"]).toBe(120)
  })

  // admits: the spec delay applies without retryAfter and is clamped to Cloudflare's 12h ceiling.
  it("retries a retryable HeraError without retryAfter after the spec delay, clamped", async () => {
    const retryable = HeraError.serviceUnavailable("down", { fields: { retryable: true } })
    const run = async (retryDelaySeconds: number) => {
      const consume = Hera.queueConsumer({
        name: "q",
        retryDelaySeconds,
        logger: capturingLogger().logger,
        handler: fail(retryable),
      })
      const { batch, settled } = fakeBatch([{}])
      await consume(batch, {})
      return settled
    }
    expect(await run(45)).toEqual([{ kind: "retry", options: { delaySeconds: 45 } }])
    expect(await run(10 ** 9)).toEqual([{ kind: "retry", options: { delaySeconds: 43_200 } }])
  })

  // admits: the documented 30 s default delay; a silent 0 would hot-loop the queue.
  it("defaults the delay to 30 seconds", async () => {
    const consume = Hera.queueConsumer({
      name: "q",
      logger: capturingLogger().logger,
      handler: fail(HeraError.serviceUnavailable("down", { fields: { retryable: true } })),
    })
    const { batch, settled } = fakeBatch([{}])
    await consume(batch, {})
    expect(settled).toEqual([{ kind: "retry", options: { delaySeconds: 30 } }])
  })

  // admits: a non-retryable error is retried now (to the DLQ via max_retries), never acked and dropped.
  it("retries a non-retryable HeraError now and logs it at error", async () => {
    const { logger, lines } = capturingLogger()
    const consume = Hera.queueConsumer({
      name: "q",
      logger,
      handler: fail(HeraError.badRequest("bad")),
    })
    const { batch, settled } = fakeBatch([{}])
    await consume(batch, {})
    expect(settled).toEqual([{ kind: "retry" }])
    expect(lines.map((l) => [l.level, l.msg, l["code"]])).toEqual([
      ["error", "hera.queue.batch_failed", "bad_request"],
    ])
  })

  // admits: a defect retries all and logs its class name, never its message.
  it("retries all on a defect and logs its class name only", async () => {
    const { logger, lines } = capturingLogger()
    const consume = Hera.queueConsumer({
      name: "q",
      logger,
      handler: () => Effect.die(new TypeError("leaky detail 42")),
    })
    const { batch, settled } = fakeBatch([{}])
    await consume(batch, {})
    expect(settled).toEqual([{ kind: "retry" }])
    expect(lines.map((l) => [l.level, l.msg, l["defect"]])).toEqual([
      ["error", "hera.queue.batch_defect", "TypeError"],
    ])
    expect(JSON.stringify(lines)).not.toContain("leaky detail 42")
  })

  // admits: a sync throw while building the Effect settles as a defect instead of rejecting the Worker.
  it("treats a handler that throws while building its Effect as a defect", async () => {
    const consume = Hera.queueConsumer({
      name: "q",
      logger: capturingLogger().logger,
      handler: () => {
        throw new RangeError("sync")
      },
    })
    const { batch, settled } = fakeBatch([{}])
    await expect(consume(batch, {})).resolves.toBeUndefined()
    expect(settled).toEqual([{ kind: "retry" }])
  })

  // admits: an interrupt-only cause has no die reason; it must still retry, not ack.
  it("treats an interrupt as a defect", async () => {
    const { logger, lines } = capturingLogger()
    const consume = Hera.queueConsumer({ name: "q", logger, handler: () => Effect.interrupt })
    const { batch, settled } = fakeBatch([{}])
    await consume(batch, {})
    expect(settled).toEqual([{ kind: "retry" }])
    expect(lines[0]?.["defect"]).toBe("Interrupt")
  })

  // admits: settlement precedes logging, so a throwing sink cannot leave the batch unsettled.
  it("settles even when the log sink throws, and never rejects", async () => {
    const consume = Hera.queueConsumer({
      name: "q",
      logger: capturingLogger(true).logger,
      handler: () => Effect.die("boom"),
    })
    const { batch, settled } = fakeBatch([{ bad: true }])
    await expect(consume(batch, {})).resolves.toBeUndefined()
    expect(settled).toEqual([{ kind: "retry" }])
  })

  // admits: a throwing retryAll is reported and the handler still resolves.
  it("logs settle_failed and resolves when retryAll throws", async () => {
    const { logger, lines } = capturingLogger()
    const consume = Hera.queueConsumer({ name: "q", logger, handler: () => Effect.die("x") })
    const { batch } = fakeBatch([{}], {
      retryAll: () => {
        throw new Error("binding gone")
      },
    })
    await expect(consume(batch, {})).resolves.toBeUndefined()
    expect(lines.map((l) => l.msg)).toEqual(["hera.queue.batch_defect", "hera.queue.settle_failed"])
  })

  // admits: without a schema bodies are untouched, and the handler gets HeraCtx and env.
  it("passes bodies through untouched without a schema and provides HeraCtx", async () => {
    let service: string | undefined
    let bodies: ReadonlyArray<unknown> = []
    const consume = Hera.queueConsumer<{ readonly tag: string }>({
      name: "Events.deadLetter",
      service: "events",
      logger: capturingLogger().logger,
      handler: (batch, env) =>
        Effect.gen(function* () {
          const ctx = yield* HeraCtx
          service = `${ctx.service}:${env.tag}`
          expect(Option.isNone(ctx.orgId)).toBe(true)
          bodies = batch.messages.map((m) => m.body)
        }),
    })
    const { batch, settled } = fakeBatch(["raw", 7])
    await consume(batch, { tag: "dlq" })
    expect(settled).toEqual([{ kind: "ack" }])
    expect(service).toBe("events:dlq")
    expect(bodies).toEqual(["raw", 7])
  })
})
