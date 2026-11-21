import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { Hera, type HeraOutboxRecord, RequestId } from "../src/index"
import { withTestCtx } from "../src/testing/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

// An outbox row records the trace and request it was written under, so the
// queue hop can link back to the producer.

class TraceDO extends Hera.TenantDurableObject.configure({ service: "outbox-trace-test", migrations: [] }) {}

const REQ = RequestId.make("req_01JAW4B8X7H2M9Q5R8T3V6Y1Z0")
const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/

/** `_hera_outbox` / dead-letter as created before trace columns (no `traceparent`). */
const LEGACY_DDL = [
  `CREATE TABLE _hera_migrations (version INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  `CREATE TABLE _hera_outbox (id TEXT NOT NULL PRIMARY KEY, org_id TEXT NOT NULL, event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL, request_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE _hera_outbox_dead_letter (id TEXT NOT NULL PRIMARY KEY, org_id TEXT NOT NULL, event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL, request_id TEXT, attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
    last_error TEXT, created_at INTEGER NOT NULL, dead_lettered_at INTEGER NOT NULL)`,
]

function setup(deliver?: (records: ReadonlyArray<HeraOutboxRecord>) => Promise<void>) {
  const harness = makeTestDurableObjectState()
  const make = () =>
    new TraceDO(harness.state, {}, {
      now: () => 1_700_000_000_000,
      outboxMaxAttempts: 1,
      ...(deliver !== undefined ? { deliverOutboxBatch: deliver } : {}),
    })
  return { harness, make }
}

/** Runs `effect` inside a span under a `HeraCtx` with `REQ`, as an rpcMethod handler would. */
const underSpan = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      const value = yield* effect
      return { span, value }
    }).pipe(Effect.withSpan("rpc.ledger.write"), withTestCtx({ requestId: REQ }))
  )

describe("outbox rows carry the enqueuing trace", () => {
  // admits: the span is runtime fiber state read inside a detached synchronous transaction
  it("a write inside transactWithOutbox stores the caller span's traceparent", async () => {
    const tenant = setup().make()
    const { span } = await underSpan(
      tenant.db.transactWithOutbox(function* (tx) {
        yield* tx.enqueueOutbox({ id: "e1", type: "test.event@1", payload: { a: 1 } })
      })
    )
    const [row] = tenant.getPendingOutboxRecords()
    const match = TP.exec(row?.traceparent ?? "")
    expect(match?.[1]).toBe(span.traceId)
    expect(match?.[2]).toBe(span.spanId)
    expect(row?.requestId).toBe(REQ)
  })

  // admits: request id precedence over runtime ctx sources
  it("a row written under a tenant ctx with no explicit requestId keeps the ctx request id", async () => {
    const tenant = setup().make()
    await tenant.runWithTenantCtx(
      tenant.db.transactWithOutbox(function* (tx) {
        yield* tx.enqueueOutbox({ id: "e2", type: "test.event@1", payload: {} })
      }).pipe(Effect.withSpan("rpc.ledger.write")),
      { requestId: REQ }
    )
    const [row] = tenant.getPendingOutboxRecords()
    expect(row?.requestId).toBe(REQ)
    expect(row?.traceparent).toMatch(TP)
  })

  // admits: a row written with no span has nothing to link to
  it("a row written outside any span has no traceparent", async () => {
    const tenant = setup().make()
    await Effect.runPromise(
      tenant.db.transactWithOutbox(function* (tx) {
        yield* tx.enqueueOutbox({ id: "e3", type: "test.event@1", payload: {} })
      })
    )
    expect(tenant.getPendingOutboxRecords()[0]?.traceparent).toBeUndefined()
  })

  // admits: schema evolution of stored SQLite state; only a wake over a real pre-change table shows it
  it("an object created before the column gains it on wake, keeps its old rows, and traces new ones", async () => {
    const { harness, make } = setup()
    for (const ddl of LEGACY_DDL) harness.state.storage.sql.exec(ddl)
    harness.state.storage.sql.exec(
      `INSERT INTO _hera_outbox (id, org_id, event_type, payload_json, request_id, attempts, next_attempt_at, last_error, created_at)
       VALUES ('old', 'x', 'test.event@1', '{}', NULL, 0, 1, NULL, 1)`
    )
    const tenant = make()
    await underSpan(
      tenant.db.transactWithOutbox(function* (tx) {
        yield* tx.enqueueOutbox({ id: "new", type: "test.event@1", payload: {} })
      })
    )
    const rows = tenant.getPendingOutboxRecords()
    expect(rows.map((r) => r.id)).toEqual(["old", "new"])
    expect(rows[0]?.traceparent).toBeUndefined()
    expect(rows[1]?.traceparent).toMatch(TP)
  })

  // admits: a column carried through two INSERT ... SELECT statements
  it("dead-lettering and replay keep the traceparent", async () => {
    const tenant = setup(() => Promise.reject(new Error("refused"))).make()
    await underSpan(
      tenant.db.transactWithOutbox(function* (tx) {
        yield* tx.enqueueOutbox({ id: "d1", type: "test.event@1", payload: {} })
      })
    )
    const original = tenant.getPendingOutboxRecords()[0]?.traceparent
    expect(original).toMatch(TP)
    await tenant.alarm()
    expect(tenant.getDeadLetteredOutboxRecords()[0]?.traceparent).toBe(original)
    tenant.replayDeadLetteredOutbox()
    expect(tenant.getPendingOutboxRecords()[0]?.traceparent).toBe(original)
  })
})
