import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
  type AlarmDriver,
  type BeforePurgeResult,
  Hera,
  type HeraJobRegistry,
  type HeraOutboxRecord,
  type TenantDurableObject,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

const T0 = 1_700_000_000_000
const BACKOFF_MS = 15_000
const MIGRATIONS = [{ version: 1, name: "001_items", sql: "CREATE TABLE items (id TEXT NOT NULL PRIMARY KEY)" }]

/** A driver that records every call instead of touching the platform alarm. */
class RecordingDriver implements AlarmDriver {
  armedAt: number | null = null
  readonly calls: Array<string> = []
  readonly set = async (atMs: number): Promise<void> => {
    this.calls.push(`set ${atMs}`)
    this.armedAt = atMs
  }
  readonly get = async (): Promise<number | null> => {
    this.calls.push("get")
    return this.armedAt
  }
  readonly clear = async (): Promise<void> => {
    this.calls.push("clear")
    this.armedAt = null
  }
}

type JobAnswer = (self: DriverDO, nowMs: number) => Promise<number | null> | number | null
type Hook = (self: DriverDO, nowMs: number) => Promise<number | void> | number | void

const Base = Hera.TenantDurableObject.configure({
  service: "driver-test",
  migrations: MIGRATIONS,
  alarmErrorBackoffMs: BACKOFF_MS,
  deliverOutboxBatch: () => undefined,
})

/** The driver is a subclass field, so the base must resolve it only after construction. */
class DriverDO extends Base {
  static readonly jobs = {
    work: (nowMs: number, self: DriverDO) => Effect.promise(async () => (await self.job?.(self, nowMs)) ?? null),
  } satisfies HeraJobRegistry<DriverDO>

  readonly driver = new RecordingDriver()
  readonly log: Array<string> = []
  job: JobAnswer | undefined
  hook: Hook | undefined
  purgeHook: (() => BeforePurgeResult) | undefined

  protected override createAlarmDriver(): AlarmDriver {
    return this.driver
  }

  /** What a host job does: run the pass and take its answer. */
  pass(): Promise<number | null> {
    return this.runCompositePass()
  }

  protected override onDomainAlarm(nowMs: number) {
    return this.hook?.(this, nowMs)
  }

  /** The protected purged mark, for the assertions. */
  sealed(): boolean {
    return this.isPurged()
  }

  protected override beforePurge(): BeforePurgeResult {
    this.log.push("beforePurge")
    return this.purgeHook?.()
  }
}

class DefaultDO extends Base {
  static readonly jobs = DriverDO.jobs
}

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect)
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function enqueue(tenantDo: TenantDurableObject, id: string): Promise<HeraOutboxRecord> {
  return tenantDo.runWithTenantCtx(
    tenantDo.db.transactWithOutbox(function* (tx) {
      return yield* tx.enqueueOutbox({ id, type: "item.created@1", payload: { id } })
    })
  )
}

function make() {
  const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
  return { harness, tenantDo: new DriverDO(harness.state, {}) }
}

describe("AlarmDriver seam", () => {
  // admits: a Hera write arms the platform alarm behind a custom owner's back; runtime routing across post-commit syncs
  it("routes every arm through a custom driver and never touches the platform alarm", async () => {
    const { harness, tenantDo } = make()
    await enqueue(tenantDo, "evt_1")
    await run(tenantDo.jobs.schedule("work", T0 + 5_000))
    await run(tenantDo.scheduleDomainAlarm(T0 + 9_000))
    await flush()
    expect(tenantDo.driver.calls.filter((call) => call.startsWith("set"))).toHaveLength(3)
    expect(tenantDo.driver.armedAt).toBe(T0 + 1)

    await tenantDo.alarm()
    expect(tenantDo.driver.armedAt).toBe(T0 + 5_000)
    expect(harness.setAlarmCalls).toEqual([])
    expect(harness.getScheduledAlarm()).toBeNull()
  })

  // admits: the wake re-arm reads a subclass driver before its field exists; construction order is runtime
  it("re-arms on wake through a driver that is a subclass field", async () => {
    const { harness, tenantDo } = make()
    await run(tenantDo.jobs.schedule("work", T0 + 5_000))
    tenantDo.driver.armedAt = null

    const woken = new DriverDO(harness.state, {})
    await flush()
    expect(woken.driver.calls).toEqual(["get", `set ${T0 + 5_000}`])
  })

  describe("runCompositePass", () => {
    // admits: the host-job pass arms the alarm itself, or a mid-pass sync overrides its answer; interleaving across an await
    it("arms nothing, defers mid-pass syncs, and answers the job's earlier time over its lease", async () => {
      const { harness, tenantDo } = make()
      await run(tenantDo.jobs.schedule("work", T0))
      const setsBefore = tenantDo.driver.calls.length
      // Mid-pass, the job is leased to now + backoff; an undeferred sync would arm that.
      tenantDo.job = async (self, nowMs) => {
        await run(self.scheduleDomainAlarm(nowMs + 50_000))
        return nowMs + 1_000
      }

      const answer = await tenantDo.pass()
      expect(tenantDo.driver.calls.slice(setsBefore)).toEqual([])
      expect(answer).toBe(T0 + 1_000)
      expect(tenantDo.getDomainAlarmAt()).toBe(T0 + 50_000)
      expect(harness.setAlarmCalls).toEqual([])
    })

    // admits: a write the pass deferred is lost from its answer; the final read must cover it
    it("answers a time that covers an outbox row written during the pass", async () => {
      const { tenantDo } = make()
      await run(tenantDo.jobs.schedule("work", T0))
      tenantDo.job = async (self, nowMs) => {
        await enqueue(self, "evt_mid_pass")
        return nowMs + 60_000
      }

      expect(await tenantDo.pass()).toBe(T0 + 1)
      expect(tenantDo.getPendingOutboxRecords()).toHaveLength(1)
    })

    // admits: the backoff invariant breaks off the default alarm path; runtime control flow
    it("answers now + backoff after a failing domain hook, and keeps the slot due", async () => {
      const { tenantDo } = make()
      await run(tenantDo.scheduleDomainAlarm(T0))
      tenantDo.hook = () => Promise.reject(new Error("boom"))

      expect(await tenantDo.pass()).toBe(T0 + BACKOFF_MS)
      expect(tenantDo.getDomainAlarmAt()).toBe(T0 + BACKOFF_MS)
    })

    // admits: a pass writes or answers a time after storage was purged under it; runtime state across an await
    it("answers null and writes nothing when storage is purged during the pass", async () => {
      const { harness, tenantDo } = make()
      await run(tenantDo.jobs.schedule("work", T0))
      tenantDo.job = async (self) => {
        await self.ctx.storage.deleteAll()
        return T0 + 1_000
      }

      expect(await tenantDo.pass()).toBeNull()
      expect(tenantDo.isInitialized()).toBe(false)
      const tables = harness.sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      expect(tables).toEqual([])
    })

    // admits: a host job on a never-written object reschedules itself forever; runtime init state
    it("answers null on a fresh object", async () => {
      const { tenantDo } = make()
      expect(await tenantDo.pass()).toBeNull()
    })
  })

  // admits: an object that ran under a custom driver strands its work after the driver is removed; platform vs SQLite state
  it("reverts: an object that ran under a custom driver re-arms under the default driver on wake", async () => {
    const { harness, tenantDo } = make()
    await run(tenantDo.jobs.schedule("work", T0 + 5_000))
    await enqueue(tenantDo, "evt_revert")
    expect(harness.getScheduledAlarm()).toBeNull()

    harness.setClock(T0 + 10)
    new DefaultDO(harness.state, {})
    await flush()
    expect(harness.getScheduledAlarm()).toBe(T0 + 11)
  })
})

describe("purgeStorage", () => {
  // admits: purge deletes data before its teardown hook or resets before the caller is answered; ordering across awaits
  it("clears the alarm, runs beforePurge, deletes all, then aborts after resolving", async () => {
    const { harness, tenantDo } = make()
    await run(tenantDo.jobs.schedule("work", T0 + 5_000))
    const deleteAll = harness.state.storage.deleteAll.bind(harness.state.storage)
    ;(harness.state.storage as { deleteAll: () => Promise<void> }).deleteAll = async () => {
      tenantDo.log.push("deleteAll")
      await deleteAll()
    }
    tenantDo.driver.calls.length = 0

    await tenantDo.purgeStorage()
    expect(tenantDo.driver.calls).toEqual(["clear"])
    expect(tenantDo.log).toEqual(["beforePurge", "deleteAll"])
    expect(tenantDo.isInitialized()).toBe(false)
    expect(harness.abortCalls).toEqual([])

    await flush()
    expect(harness.abortCalls).toEqual(["hera.purge"])
  })

  // admits: a failing teardown still deletes the data under a live harness; runtime control flow
  it("keeps the data and does not abort when beforePurge fails", async () => {
    const { harness, tenantDo } = make()
    await enqueue(tenantDo, "evt_keep")
    tenantDo.purgeHook = () => Effect.fail(new Error("dispose failed"))

    await expect(tenantDo.purgeStorage()).rejects.toThrow("dispose failed")
    await flush()
    expect(tenantDo.isInitialized()).toBe(true)
    expect(tenantDo.getPendingOutboxRecords()).toHaveLength(1)
    expect(tenantDo.driver.armedAt).toBeNull()
    expect(harness.abortCalls).toEqual([])
  })

  // admits: a request that awaited across the purge re-creating the emptied storage; runtime state, not a type
  it("refuses every statement after the purge and re-initialises nothing", async () => {
    const { tenantDo } = make()
    await run(tenantDo.db.transactSync((tx) => tx.exec("INSERT INTO items (id) VALUES ('a')")))
    expect(tenantDo.sealed()).toBe(false)

    await tenantDo.purgeStorage()
    expect(tenantDo.sealed()).toBe(true)
    const refused = [
      tenantDo.db.transactSync((tx) => tx.exec("INSERT INTO items (id) VALUES ('b')")),
      tenantDo.db.transactWithOutbox((tx) => tx.enqueueOutbox({ id: "evt_late", type: "late", payload: {} })),
      tenantDo.db.exec("INSERT INTO items (id) VALUES ('c')"),
      tenantDo.db.query("SELECT id FROM items"),
    ]
    for (const effect of refused) {
      const exit = await Effect.runPromiseExit(effect as Effect.Effect<unknown, unknown, never>)
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("Storage was purged")
    }
    expect(tenantDo.isInitialized()).toBe(false)
    await expect(run(tenantDo.jobs.schedule("work", T0 + 5_000))).rejects.toThrow()
    expect(tenantDo.isInitialized()).toBe(false)
  })

  // admits: the mark landing before beforePurge, refusing the writes a host drains there; ordering across awaits
  it("lets beforePurge write, and marks only after it resolves", async () => {
    const { tenantDo } = make()
    tenantDo.purgeHook = () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Promise.resolve())
        tenantDo.log.push(`sealed=${tenantDo.sealed()}`)
        yield* tenantDo.db.transactSync((tx) => tx.exec("INSERT INTO items (id) VALUES ('drained')"))
      })

    await tenantDo.purgeStorage()
    expect(tenantDo.log).toEqual(["beforePurge", "sealed=false"])
    expect(tenantDo.sealed()).toBe(true)
    expect(tenantDo.isInitialized()).toBe(false)
  })

  // admits: a failed purge leaving the object sealed while its data is intact; runtime control flow
  it("leaves the object writable when beforePurge fails", async () => {
    const { tenantDo } = make()
    tenantDo.purgeHook = () => Effect.fail(new Error("dispose failed"))
    await expect(tenantDo.purgeStorage()).rejects.toThrow("dispose failed")
    expect(tenantDo.sealed()).toBe(false)
    await run(tenantDo.db.transactSync((tx) => tx.exec("INSERT INTO items (id) VALUES ('kept')")))
    expect(await run(tenantDo.db.query("SELECT id FROM items"))).toEqual([{ id: "kept" }])
  })

  // admits: a default-driver purge leaves the platform alarm set before deleteAll; ordering across awaits
  it("clears the platform alarm under the default driver", async () => {
    const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
    const tenantDo = new DefaultDO(harness.state, {})
    await run(tenantDo.jobs.schedule("work", T0 + 5_000))
    expect(harness.getScheduledAlarm()).toBe(T0 + 5_000)

    await tenantDo.purgeStorage()
    expect(harness.getScheduledAlarm()).toBeNull()
  })
})
