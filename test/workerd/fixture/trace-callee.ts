import { WorkerEntrypoint } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { createHeraLogger, type LogEntry } from "../../../src/core/logger/index.js"
import { HeraOutbox, TenantDurableObject } from "../../../src/server/durable-object/index.js"
import { queueConsumer } from "../../../src/server/queue/index.js"
import { rpcClient, rpcMethod } from "../../../src/server/rpc/index.js"

// Callee WorkerEntrypoint -> tenant Ledger DO -> outbox -> queue -> queueConsumer.
interface Env {
  readonly LEDGER: DurableObjectNamespace<Ledger>
  readonly EVENTS: Queue
}

const ORG_NAME = "org:01ARZ3NDEKTSV4RRFFQ69G5FAV"

/** What each hop reports about the span and request it ran under. */
const spanReport = Effect.gen(function* () {
  const span = yield* Effect.orDie(Effect.currentSpan)
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: Option.isSome(span.parent) ? span.parent.value.spanId : null,
  }
})

export class Ledger extends TenantDurableObject.configure<Env>({
  service: "workerd-trace-ledger",
  migrations: [],
  deliverOutboxBatch: HeraOutbox.queueSink({ trace: true }),
}) {
  write(...args: ReadonlyArray<unknown>) {
    const db = this.db
    const method = rpcMethod({
      name: "write",
      service: "ledger",
      handler: (_input: unknown, ctx) =>
        Effect.gen(function* () {
          const span = yield* spanReport
          const row = yield* db.transactWithOutbox(function* (tx) {
            return yield* tx.enqueueOutbox({ type: "ledger.written@1", payload: { n: 1 } })
          })
          return { ...span, requestId: ctx.requestId, outbox: { traceparent: row.traceparent ?? null, requestId: row.requestId } }
        }),
    })
    return Reflect.apply(method, undefined, [...args])
  }
}

const calleeLines: Array<LogEntry> = []
const consumed: Array<unknown> = []

export class Callee extends WorkerEntrypoint<Env> {
  record(...args: ReadonlyArray<unknown>) {
    // The structural stub type; the full DurableObjectStub<Ledger> mapped type is too deep for tsc.
    const stub = () => this.env.LEDGER.getByName(ORG_NAME) as unknown as { write(input: unknown): Promise<unknown> }
    const ledger = rpcClient(stub, { service: "ledger", propagate: true })
    const logger = createHeraLogger({ service: "callee", sink: (_line, entry) => void calleeLines.push(entry) })
    const method = rpcMethod({
      name: "record",
      service: "callee",
      handler: (_input: unknown, ctx) =>
        Effect.gen(function* () {
          yield* logger.info("callee.recorded")
          const span = yield* spanReport
          const ledgerResult = yield* ledger.write({ n: 1 })
          return { ...span, requestId: ctx.requestId, log: calleeLines.at(-1) ?? null, ledger: ledgerResult }
        }),
    })
    return Reflect.apply(method, undefined, [...args])
  }

  consumed(): ReadonlyArray<unknown> {
    return consumed
  }
}

export default {
  fetch: () => new Response("callee"),
  queue: queueConsumer<Env>({
    name: "Ledger.events",
    handler: (batch) =>
      Effect.gen(function* () {
        const span = yield* Effect.orDie(Effect.currentSpan)
        consumed.push({
          linkTraceIds: span.links.map((link) => link.span.traceId),
          messages: batch.messages.map((m) => ({ body: m.body, requestId: m.requestId ?? null })),
        })
      }),
  }),
}
