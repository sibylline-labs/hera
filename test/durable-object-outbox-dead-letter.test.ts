import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  Hera,
  type HeraOutboxDeliveryReport,
  type HeraOutboxRecord,
  type HeraTenantDurableObjectOptions,
  SyncTx,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

// One record that keeps failing must never hold the tenant's outbox for good.

class OutboxDO extends Hera.TenantDurableObject.configure({
  service: "app-outbox-test",
  migrations: [],
  outboxBackoff: { baseDelayMs: 1_000, maxDelayMs: 4_000, jitterRatio: 0 },
}) {}

type Deliver = NonNullable<HeraTenantDurableObjectOptions["deliverOutboxBatch"]>

function setup(options: Partial<HeraTenantDurableObjectOptions> & { readonly deliver: Deliver }) {
  const clock = { now: 1_700_000_000_000 }
  const lines: Array<Record<string, unknown>> = []
  const harness = makeTestDurableObjectState()
  const make = () =>
    new OutboxDO(harness.state, {}, {
      ...options,
      now: () => clock.now,
      sink: (_line, entry) => {
        lines.push(entry)
      },
      deliverOutboxBatch: options.deliver,
    })
  const tenant = make()
  const enqueue = (id: string, type = "test.event@1") =>
    tenant.runWithTenantCtx(
      tenant.db.transactWithOutbox(function* (tx) {
        yield* tx.enqueueOutbox({ id, type, payload: { id } })
      })
    )
  return { clock, lines, harness, tenant, make, enqueue }
}

const failing =
  (poison: ReadonlySet<string>, delivered: Array<string>): Deliver =>
  (records) => {
    for (const record of records) {
      if (poison.has(record.id)) {
        return Promise.reject(new Error(`sink refused ${record.id}`))
      }
    }
    delivered.push(...records.map((r) => r.id))
    return Promise.resolve()
  }

const deadLetterLines = (lines: ReadonlyArray<Record<string, unknown>>) =>
  lines.filter((line) => line.msg === "hera.outbox.dead_lettered")

describe("outbox dead-letter", () => {
  // admits: a record that fails forever holding every record behind it, or leaving silently; runtime state over time, no type holds it.
  it("dead-letters a record after outboxMaxAttempts with one error line, and the rows behind it drain", async () => {
    const delivered: Array<string> = []
    const t = setup({ outboxMaxAttempts: 3, outboxBatchSize: 1, deliver: failing(new Set(["poison"]), delivered) })
    await t.enqueue("poison")
    t.clock.now += 1
    await t.enqueue("after")

    for (let pass = 0; pass < 3; pass++) {
      await t.tenant.alarm()
      t.clock.now += 10_000
    }

    expect(t.tenant.getPendingOutboxRecords().map((r) => r.id)).toEqual(["after"])
    const dead = t.tenant.getDeadLetteredOutboxRecords()
    expect(dead.map((r) => r.id)).toEqual(["poison"])
    expect(dead[0]).toMatchObject({ type: "test.event@1", attempts: 3, payload: { id: "poison" } })
    expect(dead[0]?.lastError).toContain("sink refused poison")

    const logged = deadLetterLines(t.lines)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({
      level: "error",
      outboxId: "poison",
      type: "test.event@1",
      attempts: 3,
    })
    expect(String(logged[0]?.lastError)).toContain("sink refused poison")
    expect(JSON.stringify(logged[0])).not.toContain("payload")

    await t.tenant.alarm()
    expect(delivered).toEqual(["after"])
    expect(t.tenant.getPendingOutboxRecords()).toHaveLength(0)
  })

  // admits: strict streams (yak, accounts, asks, graph-v1 seq order) reordered by the new mode; ordering is runtime.
  it("strict: a backed-off head holds the rest and the next retry is the head's time", async () => {
    const delivered: Array<string> = []
    const t = setup({ outboxBatchSize: 1, deliver: failing(new Set(["poison"]), delivered) })
    await t.enqueue("poison")
    t.clock.now += 1
    await t.enqueue("after")

    await t.tenant.alarm()
    expect(delivered).toEqual([])
    expect(t.tenant.getNextOutboxRetryAt()).toBe(t.clock.now + 1_000)
    await t.tenant.runWithTenantCtx(t.tenant.drainOutbox(t.clock.now + 500))
    expect(delivered).toEqual([])
  })

  // admits: a backed-off record delaying a later one past one backoff step on an independent object; ordering is runtime.
  it("independent: a backed-off record does not hold a later one", async () => {
    const delivered: Array<string> = []
    const t = setup({
      outboxBatchSize: 1,
      outboxOrdering: "independent",
      deliver: failing(new Set(["poison"]), delivered),
    })
    await t.enqueue("poison")
    t.clock.now += 1
    await t.enqueue("after")

    await t.tenant.alarm()
    expect(delivered).toEqual([])
    // The next pass, inside one backoff step of the failure, delivers the record behind it.
    expect(t.tenant.getNextOutboxRetryAt()).toBe(t.clock.now)
    await t.tenant.alarm()
    expect(delivered).toEqual(["after"])
    expect(t.tenant.getPendingOutboxRecords().map((r) => r.id)).toEqual(["poison"])
    expect(t.tenant.getNextOutboxRetryAt()).toBe(t.clock.now + 1_000)
    expect(t.harness.getScheduledAlarm()).toBe(t.clock.now + 1_000)
  })

  // admits: a partial report acking a failed record or backing off delivered ones; the report is runtime data.
  it("a per-record report acks the rest and backs off only the named records", async () => {
    const batches: Array<ReadonlyArray<string>> = []
    const deliver: Deliver = (records: ReadonlyArray<HeraOutboxRecord>): Promise<HeraOutboxDeliveryReport> => {
      batches.push(records.map((r) => r.id))
      return Promise.resolve({
        failed: records
          .filter((r) => r.id === "b")
          .map((r) => ({ id: r.id, reason: new Error("b failed") })),
      })
    }
    const t = setup({ outboxOrdering: "independent", deliver })
    await t.enqueue("a")
    await t.enqueue("b")
    await t.enqueue("c")

    await t.tenant.alarm()
    expect(batches[0]).toEqual(["a", "b", "c"])
    const pending = t.tenant.getPendingOutboxRecords()
    expect(pending.map((r) => r.id)).toEqual(["b"])
    expect(pending[0]?.attempts).toBe(1)
    expect(pending[0]?.lastError).toContain("b failed")
  })

  // admits: a dead letter that cannot come back, or comes back without an alarm and strands; runtime state.
  it("replay moves dead letters back with zero attempts, arms the alarm and they deliver", async () => {
    const poison = new Set(["poison"])
    const delivered: Array<string> = []
    const t = setup({ outboxMaxAttempts: 1, deliver: failing(poison, delivered) })
    await t.enqueue("poison")
    await t.tenant.alarm()
    expect(t.tenant.getDeadLetteredOutboxRecords()).toHaveLength(1)
    expect(t.tenant.getPendingOutboxRecords()).toHaveLength(0)

    poison.clear()
    t.clock.now += 60_000
    expect(t.tenant.replayDeadLetteredOutbox(["unknown-id"])).toBe(0)
    expect(t.tenant.replayDeadLetteredOutbox()).toBe(1)
    expect(t.tenant.getDeadLetteredOutboxRecords()).toHaveLength(0)
    const pending = t.tenant.getPendingOutboxRecords()
    expect(pending[0]).toMatchObject({ id: "poison", attempts: 0, nextAttemptAt: t.clock.now })
    expect(t.harness.getScheduledAlarm()).toBe(t.clock.now + 1)

    await t.tenant.alarm()
    expect(delivered).toEqual(["poison"])
  })

  // admits: two drains on one record dead-lettering a delivered row or hitting the dead-letter primary key; an interleaving, not a type.
  it("a failure for a row another drain already removed is a no-op", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const deliver: Deliver = async () => {
      calls += 1
      if (calls === 1) {
        await gate
        throw new Error("late failure")
      }
    }
    const t = setup({ outboxMaxAttempts: 1, deliver })
    await t.enqueue("r")
    const slow = t.tenant.runWithTenantCtx(t.tenant.drainOutbox())
    await t.tenant.runWithTenantCtx(t.tenant.drainOutbox())
    expect(t.tenant.getPendingOutboxRecords()).toHaveLength(0)
    release?.()
    const result = await slow
    expect(result.failed).toBe(0)
    expect(t.tenant.getDeadLetteredOutboxRecords()).toHaveLength(0)
    expect(deadLetterLines(t.lines)).toHaveLength(0)
  })

  // admits: an object created before the table existed failing every dead-letter read or move; storage state on wake.
  it("an object initialised before the dead-letter table existed gains it on wake", async () => {
    const t = setup({ deliver: () => undefined })
    // hera-allow: raw-effect-run
    await t.tenant.runWithTenantCtx(t.tenant.db.transactSync(SyncTx.succeed(undefined)))
    t.harness.state.storage.sql.exec("DROP TABLE _hera_outbox_dead_letter").toArray()
    const woken = t.make()
    expect(woken.getDeadLetteredOutboxRecords()).toEqual([])
  })

  // admits: a new code path dropping dead letters silently; one SQL string is not worth an ast-grep rule.
  it("only replay deletes from the dead-letter table", () => {
    const root = join(import.meta.dirname, "../src")
    const files: Array<string> = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith(".ts")) files.push(path)
      }
    }
    walk(root)
    const deleting = files.filter((f) => /DELETE FROM _hera_outbox_dead_letter/.test(readFileSync(f, "utf8")))
    expect(deleting.map((f) => f.slice(root.length + 1))).toEqual(["server/durable-object/outbox/dead-letter.ts"])
  })
})
