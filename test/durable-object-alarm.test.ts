import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import {
  Hera,
  type HeraMigration,
  type HeraOutboxRecord,
  HeraSqlError,
  SyncTx,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

const MIGRATIONS: ReadonlyArray<HeraMigration> = [
  { version: 1, name: "001_items", sql: "CREATE TABLE items (id TEXT NOT NULL PRIMARY KEY)" },
]
const T0 = 1_700_000_000_000
const BACKOFF_MS = 15_000

type Hook = (
  self: AlarmDO,
  nowMs: number
) => Effect.Effect<number | void, unknown, never> | Promise<number | void> | number | void

class AlarmDO extends Hera.TenantDurableObject.configure({
  service: "alarm-test",
  migrations: MIGRATIONS,
  alarmErrorBackoffMs: BACKOFF_MS,
  outboxBackoff: { baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0 },
}) {
  hook: Hook | undefined
  readonly fires: Array<number> = []

  protected override onDomainAlarm(nowMs: number) {
    this.fires.push(nowMs)
    return this.hook?.(this, nowMs)
  }
}

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect)
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function initialized(tenantDo: AlarmDO): AlarmDO {
  Effect.runSync(tenantDo.db.transactSync(SyncTx.succeed(undefined)))
  return tenantDo
}

function enqueue(tenantDo: AlarmDO, id: string): Promise<HeraOutboxRecord> {
  return tenantDo.runWithTenantCtx(
    tenantDo.db.transactWithOutbox(function* (tx) {
      return yield* tx.enqueueOutbox({ id, type: "item.created@1", payload: { id } })
    })
  )
}

describe("TenantDurableObject composite alarm self-healing", () => {
  // admits: a failing onDomainAlarm strands the domain slot; runtime control flow across an awaited hook, no type holds it
  it.each([
    ["Effect.die", () => Effect.die(new Error("boom"))],
    ["a synchronous throw", () => {
      throw new Error("boom")
    }],
    ["a rejected promise", () => Promise.reject(new Error("boom"))],
  ] as ReadonlyArray<readonly [string, Hook]>)(
    "keeps the domain alarm due after a hook that fails with %s, and calls the hook again",
    async (_label, failingHook) => {
      const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
      const tenantDo = new AlarmDO(harness.state, {})
      tenantDo.hook = failingHook
      await run(tenantDo.scheduleDomainAlarm(T0))

      await expect(tenantDo.alarm()).resolves.toBeUndefined()
      expect(tenantDo.getDomainAlarmAt()).toBe(T0 + BACKOFF_MS)
      expect(harness.getScheduledAlarm()).toBe(T0 + BACKOFF_MS)

      tenantDo.hook = undefined
      harness.setClock(T0 + BACKOFF_MS)
      await tenantDo.alarm()
      expect(tenantDo.fires).toEqual([T0, T0 + BACKOFF_MS])
      expect(tenantDo.getDomainAlarmAt()).toBeNull()
    }
  )

  // admits: the hook return overwrites an earlier mid-pass arm; an interleaving across an await
  it("never moves a scheduleDomainAlarm made during the hook later than it was armed", async () => {
    const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
    const tenantDo = new AlarmDO(harness.state, {})
    tenantDo.hook = async (self, nowMs) => {
      await Promise.resolve()
      await run(self.scheduleDomainAlarm(nowMs + 1_000))
      return nowMs + 50_000
    }
    await run(tenantDo.scheduleDomainAlarm(T0))
    await tenantDo.alarm()
    expect(tenantDo.getDomainAlarmAt()).toBe(T0 + 1_000)
    expect(harness.getScheduledAlarm()).toBe(T0 + 1_000)

    // An earlier return still wins over a later mid-pass arm.
    harness.setClock(T0 + 1_000)
    tenantDo.hook = async (self, nowMs) => {
      await run(self.scheduleDomainAlarm(nowMs + 9_000))
      return nowMs + 500
    }
    await tenantDo.alarm()
    expect(tenantDo.getDomainAlarmAt()).toBe(T0 + 1_500)
  })

  describe("re-arms a lost platform alarm on wake", () => {
    // admits: a lost platform alarm strands outbox rows until the next write; platform vs SQLite state
    it("for a pending outbox row", async () => {
      const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
      const first = new AlarmDO(harness.state, {}, { deliverOutboxBatch: () => undefined })
      await enqueue(first, "evt_wake_1")
      await harness.state.storage.deleteAlarm()
      harness.setClock(T0 + 10)

      new AlarmDO(harness.state, {})
      await flush()
      expect(harness.getScheduledAlarm()).toBe(T0 + 11)
    })

    // admits: a lost platform alarm strands a due domain slot; platform vs SQLite state
    it("for a domain alarm", async () => {
      const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
      const first = new AlarmDO(harness.state, {})
      await run(first.scheduleDomainAlarm(T0 + 60_000))
      await harness.state.storage.deleteAlarm()

      new AlarmDO(harness.state, {})
      await flush()
      expect(harness.getScheduledAlarm()).toBe(T0 + 60_000)
    })

    // admits: the wake re-arm moves an earlier alarm later or writes to a fresh object; runtime state
    it("leaves an alarm already set for then or earlier alone, and arms nothing on a fresh object", async () => {
      const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
      const first = new AlarmDO(harness.state, {})
      await run(first.scheduleDomainAlarm(T0 + 60_000))
      await harness.state.storage.setAlarm(T0 + 5_000)
      const callsBefore = harness.setAlarmCalls.length

      new AlarmDO(harness.state, {})
      await flush()
      expect(harness.getScheduledAlarm()).toBe(T0 + 5_000)
      expect(harness.setAlarmCalls).toHaveLength(callsBefore)

      const fresh = makeTestDurableObjectState({ initialTimeMs: T0 })
      new AlarmDO(fresh.state, {})
      await flush()
      expect(fresh.setAlarmCalls).toHaveLength(0)
    })
  })

  // admits: setAlarm(<= 0) throws inside every outbox commit; a number vs the clock is not a type
  it("arms a positive alarm for a row due at 0", async () => {
    const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
    const tenantDo = initialized(new AlarmDO(harness.state, {}))
    harness.sqliteDb.exec(
      `INSERT INTO _hera_outbox (id, org_id, event_type, payload_json, request_id, attempts, next_attempt_at, last_error, created_at)
       VALUES ('evt_zero', '${tenantDo.orgId}', 'item.created@1', 'null', NULL, 0, 0, NULL, 0)`
    )
    await enqueue(tenantDo, "evt_after_zero")
    await flush()
    expect(harness.getScheduledAlarm()).toBe(T0 + 1)
  })

  // admits: a rejected post-commit setAlarm goes unhandled; promise lifecycle
  it("catches and logs a rejected setAlarm from the post-commit slot sync", async () => {
    const logs: Array<Record<string, unknown>> = []
    const harness = makeTestDurableObjectState({
      initialTimeMs: T0,
      onSetAlarm: () => {
        throw new Error("storage unavailable")
      },
    })
    const tenantDo = new AlarmDO(harness.state, {}, { sink: (_line, entry) => logs.push(entry) })
    await enqueue(tenantDo, "evt_arm_fail")
    await flush()
    const armFailed = logs.find((entry) => entry.msg === "hera.alarm.arm_failed")
    expect(armFailed).toBeDefined()
    expect(JSON.stringify(armFailed)).toContain(tenantDo.orgId)
  })

  // admits: a newer due row overtakes a backed-off head; SQL ordering semantics
  it("keeps per-stream order after a failed send: only a due prefix of the outbox drains", async () => {
    const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
    const sent: Array<ReadonlyArray<string>> = []
    let failSend = true
    const tenantDo = new AlarmDO(harness.state, {}, {
      deliverOutboxBatch: (batch) => {
        if (failSend) {
          throw new Error("upstream 503")
        }
        sent.push(batch.map((record) => record.id))
      },
    })
    await enqueue(tenantDo, "evt_seq_1")
    await tenantDo.alarm()
    failSend = false

    harness.setClock(T0 + 10)
    await enqueue(tenantDo, "evt_seq_2")
    expect(tenantDo.getNextOutboxRetryAt()).toBe(T0 + 1_000)
    expect(harness.getScheduledAlarm()).toBe(T0 + 1_000)

    await tenantDo.alarm()
    expect(sent).toEqual([])

    harness.setClock(T0 + 1_000)
    await tenantDo.alarm()
    expect(sent).toEqual([["evt_seq_1", "evt_seq_2"]])
  })

  describe("does not re-initialise storage purged while the alarm runs", () => {
    const tableCount = (harness: ReturnType<typeof makeTestDurableObjectState>): number =>
      (harness.sqliteDb
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")
        .get() as { n: number }).n

    // admits: a transaction after a mid-alarm deleteAll re-creates every table; runtime state
    it("refuses a transaction from the hook after deleteAll, and schedules nothing", async () => {
      const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
      const tenantDo = new AlarmDO(harness.state, {})
      let txExit: Exit.Exit<unknown, unknown> | undefined
      tenantDo.hook = async (self, nowMs) => {
        await self.ctx.storage.deleteAll()
        txExit = await Effect.runPromiseExit(
          self.db.transactWithOutbox(function* (tx) {
            yield* tx.enqueueOutbox({ type: "item.purged@1", payload: null })
          })
        )
        return nowMs + 1_000
      }
      await run(tenantDo.scheduleDomainAlarm(T0))

      await expect(tenantDo.alarm()).resolves.toBeUndefined()
      expect(txExit !== undefined && Exit.isFailure(txExit)).toBe(true)
      if (txExit !== undefined && Exit.isFailure(txExit)) {
        expect(HeraSqlError.is(Cause.squash(txExit.cause))).toBe(true)
      }
      expect(tenantDo.isInitialized()).toBe(false)
      expect(tableCount(harness)).toBe(0)
      expect(harness.getScheduledAlarm()).toBeNull()
    })

    // admits: the post-delivery ack hits dropped tables and the alarm rejects; runtime state
    it("survives a purge during outbox delivery", async () => {
      const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
      const tenantDo = new AlarmDO(harness.state, {}, {
        deliverOutboxBatch: () => harness.state.storage.deleteAll(),
      })
      await enqueue(tenantDo, "evt_purge_1")

      await expect(tenantDo.alarm()).resolves.toBeUndefined()
      expect(tenantDo.isInitialized()).toBe(false)
      expect(tableCount(harness)).toBe(0)
    })
  })
})
