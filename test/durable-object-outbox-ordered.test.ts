import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { Hera, HeraOutbox, type HeraMigration } from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

// `enqueueOutbox({ ordered: true })` takes the object's next sequence number in SQLite, inside the
// enqueuing transaction, so it survives a new isolate and goes back on a rollback.

const LEGACY_SEQ: HeraMigration = {
  version: 1,
  name: "legacy_seq",
  sql: [
    "CREATE TABLE legacy_seq (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)",
    "INSERT INTO legacy_seq (id, seq) VALUES (1, 41)",
    HeraOutbox.seedSequenceSql("(SELECT seq FROM legacy_seq WHERE id = 1)"),
  ],
}

class OrderedDO extends Hera.TenantDurableObject.configure({ service: "outbox-ordered-test", migrations: [] }) {}
class SeededDO extends Hera.TenantDurableObject.configure({ service: "outbox-ordered-test", migrations: [LEGACY_SEQ] }) {}

function objectOver<T>(Ctor: new (...args: ConstructorParameters<typeof OrderedDO>) => T) {
  const harness = makeTestDurableObjectState()
  return (nowMs = 1_700_000_000_000) => new Ctor(harness.state, {}, { now: () => nowMs })
}

function enqueueOrdered(tenant: OrderedDO, count = 1) {
  return Effect.runPromise(
    tenant.db.transactWithOutbox(function* (tx) {
      const seqs: Array<number> = []
      for (let i = 0; i < count; i++) {
        const record = yield* tx.enqueueOutbox({ ordered: true, type: "test.event@1", payload: (seq) => ({ seq }) })
        seqs.push(record.seq)
      }
      return seqs
    })
  )
}

describe("enqueueOutbox({ ordered: true })", () => {
  // admits: integration: the number lives in SQLite; an isolate counter passes one instance and restarts at 1
  it("takes 1, 2, 3, and a new instance over the same storage takes 4", async () => {
    const make = objectOver(OrderedDO)
    expect(await enqueueOrdered(make(), 3)).toEqual([1, 2, 3])
    const restarted = make()
    expect(await enqueueOrdered(restarted)).toEqual([4])
    expect(restarted.getPendingOutboxRecords().map((r) => r.payload)).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }])
  })

  // admits: integration: the take and the insert share the caller's transactionSync, so a failed transaction leaves no gap
  it("a transaction that fails after an ordered enqueue leaves no row and the next commit takes the same seq", async () => {
    const tenant = objectOver(OrderedDO)()
    await enqueueOrdered(tenant)
    const failed = await Effect.runPromiseExit(
      tenant.db.transactWithOutbox(function* (tx) {
        yield* tx.enqueueOutbox({ ordered: true, type: "test.event@1", payload: {} })
        return yield* tx.fail("abort")
      })
    )
    expect(failed._tag).toBe("Failure")
    expect(tenant.getPendingOutboxRecords()).toHaveLength(1)
    expect(await enqueueOrdered(tenant)).toEqual([2])
  })

  // admits: integration: a bare enqueue holds its own savepoint; without it the take commits before the payload throws
  it("a bare ordered enqueue whose payload function throws takes no number", async () => {
    const tenant = objectOver(OrderedDO)()
    const thrown = Effect.runSyncExit(
      tenant.db.enqueueOutbox({ ordered: true, type: "test.event@1", payload: (): never => { throw new Error("bad payload") } })
    )
    expect(thrown._tag).toBe("Failure")
    const record = Effect.runSync(tenant.db.enqueueOutbox({ ordered: true, type: "test.event@1", payload: {} }))
    expect(record.seq).toBe(1)
  })

  // admits: algorithmic: the created_at high-water; without it a later seq sorts first under (created_at, id)
  it("a clock that steps back still drains in seq order", async () => {
    const make = objectOver(OrderedDO)
    await enqueueOrdered(make(2_000), 2)
    const earlierClock = make(1_000)
    await enqueueOrdered(earlierClock)
    const rows = earlierClock.getPendingOutboxRecords()
    expect(rows.map((r) => (r.payload as { seq: number }).seq)).toEqual([1, 2, 3])
    expect(rows.map((r) => r.createdAt)).toEqual([2_000, 2_000, 2_000])
  })

  // admits: algorithmic: the id width and prefix are the contract a consumer's dedupe and drain order rely on
  it("derives the id from the prefix and the 16-digit seq, and returns the built payload", async () => {
    const tenant = objectOver(OrderedDO)()
    const record = await Effect.runPromise(
      tenant.db.transactWithOutbox((tx) =>
        tx.enqueueOutbox({ ordered: true, idPrefix: "yak_", type: "test.event@1", payload: (seq) => ({ seq }) })
      )
    )
    expect(record.id).toBe("yak_0000000000000001")
    expect(record.payload).toEqual({ seq: 1 })
    expect(tenant.getPendingOutboxRecords()[0]?.id).toBe("yak_0000000000000001")
    const plain = Effect.runSync(tenant.db.enqueueOutbox({ ordered: true, type: "test.event@1", payload: "x" }))
    expect(plain.id).toBe("outbox_seq_0000000000000002")
    // @ts-expect-error an ordered enqueue derives its id
    tenant.db.enqueueOutbox({ ordered: true, id: "x", type: "test.event@1", payload: {} })
  })

  // admits: boundary-io: the seed's SQLite upsert raises and never lowers, and runs inside a consumer migration
  it("a migration seed carries an existing counter over and a lower seed never lowers it", async () => {
    const tenant = objectOver(SeededDO)()
    expect(await enqueueOrdered(tenant as unknown as OrderedDO)).toEqual([42])
    Effect.runSync(tenant.db.exec(HeraOutbox.seedSequenceSql("?"), [5]))
    expect(await enqueueOrdered(tenant as unknown as OrderedDO)).toEqual([43])
    Effect.runSync(tenant.db.exec(HeraOutbox.seedSequenceSql("?"), [100]))
    expect(await enqueueOrdered(tenant as unknown as OrderedDO)).toEqual([101])
  })
})
