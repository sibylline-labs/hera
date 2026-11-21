import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import {
  Hera,
  type HeraJobRegistry,
  type HeraJobScheduler,
  HeraJobError,
  SyncTx,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0)
const BACKOFF_MS = 15_000

type JobOutcome = number | null | "throw"

class JobsDO extends Hera.KeyedDurableObject.configure({
  service: "jobs-test",
  alarmErrorBackoffMs: BACKOFF_MS,
}) {
  static readonly jobs = {
    a: (nowMs: number, self: JobsDO) => self.fire("a", nowMs),
    b: (nowMs: number, self: JobsDO) => self.fire("b", nowMs),
    tick: (nowMs: number, self: JobsDO) => self.fire("tick", nowMs),
  } satisfies HeraJobRegistry<JobsDO>
  declare readonly jobs: HeraJobScheduler<keyof typeof JobsDO.jobs>

  readonly fires: Array<[string, number]> = []
  outcome: Partial<Record<string, JobOutcome>> = {}
  during: ((self: JobsDO) => void) | undefined

  fire(name: string, nowMs: number): Effect.Effect<number | null, Error> {
    this.fires.push([name, nowMs])
    const outcome = this.outcome[name] ?? null
    return Effect.promise(() => Promise.resolve()).pipe(
      Effect.tap(() => Effect.sync(() => this.during?.(this))),
      Effect.flatMap(() =>
        outcome === "throw" ? Effect.fail(new Error(`${name} failed`)) : Effect.succeed(outcome)
      )
    )
  }
}

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect)

function make() {
  const harness = makeTestDurableObjectState({ idName: "jobs", initialTimeMs: T0 })
  return { harness, jobsDo: new JobsDO(harness.state, {}) }
}

describe("this.jobs named-job scheduler", () => {
  // admits: two jobs on one platform alarm fire out of order or one is lost; runtime ordering across passes
  it("fires two jobs with different due times in order on one alarm slot", async () => {
    const { harness, jobsDo } = make()
    await run(jobsDo.jobs.schedule("b", T0 + 2_000))
    await run(jobsDo.jobs.schedule("a", T0 + 1_000))
    expect(harness.getScheduledAlarm()).toBe(T0 + 1_000)

    harness.setClock(T0 + 1_000)
    await jobsDo.alarm()
    expect(jobsDo.fires).toEqual([["a", T0 + 1_000]])
    expect(harness.getScheduledAlarm()).toBe(T0 + 2_000)

    harness.setClock(T0 + 2_000)
    await jobsDo.alarm()
    expect(jobsDo.fires.map(([name]) => name)).toEqual(["a", "b"])
    expect(jobsDo.jobs.earliestAt()).toBeNull()
  })

  // admits: jobs due together run in a nondeterministic order; SQL ordering
  it("runs jobs due in the same pass by due time, then name", async () => {
    const { harness, jobsDo } = make()
    await run(jobsDo.jobs.schedule("b", T0 + 10))
    await run(jobsDo.jobs.schedule("a", T0 + 10))
    await run(jobsDo.jobs.schedule("tick", T0 + 5))
    harness.setClock(T0 + 100)
    await jobsDo.alarm()
    expect(jobsDo.fires.map(([name]) => name)).toEqual(["tick", "a", "b"])
  })

  // admits: a throwing job is lost or strands the platform alarm; control flow across an awaited handler
  it("retries a throwing job after backoff and keeps the platform alarm armed", async () => {
    const { harness, jobsDo } = make()
    jobsDo.outcome.a = "throw"
    await run(jobsDo.jobs.schedule("a", T0))
    await run(jobsDo.jobs.schedule("b", T0))
    await expect(jobsDo.alarm()).resolves.toBeUndefined()
    expect(jobsDo.fires.map(([name]) => name)).toEqual(["a", "b"])
    expect(jobsDo.jobs.nextAt("a")).toBe(T0 + BACKOFF_MS)
    expect(harness.getScheduledAlarm()).toBe(T0 + BACKOFF_MS)

    jobsDo.outcome.a = null
    harness.setClock(T0 + BACKOFF_MS)
    await jobsDo.alarm()
    expect(jobsDo.fires.map(([name]) => name)).toEqual(["a", "b", "a"])
    expect(jobsDo.jobs.nextAt("a")).toBeNull()
  })

  // admits: a cron job runs once and stops; runtime clock
  it("re-arms a cron job to its next tick", async () => {
    const { harness, jobsDo } = make()
    await run(jobsDo.jobs.schedule("tick", "*/5 * * * *"))
    expect(jobsDo.jobs.nextAt("tick")).toBe(T0 + 5 * 60_000)

    harness.setClock(T0 + 5 * 60_000)
    await jobsDo.alarm()
    expect(jobsDo.jobs.nextAt("tick")).toBe(T0 + 10 * 60_000)
    expect(harness.getScheduledAlarm()).toBe(T0 + 10 * 60_000)

    // An answer earlier than the next tick wins; the tick after it still re-arms.
    jobsDo.outcome.tick = T0 + 12 * 60_000
    harness.setClock(T0 + 10 * 60_000)
    await jobsDo.alarm()
    expect(jobsDo.jobs.nextAt("tick")).toBe(T0 + 12 * 60_000)

    jobsDo.outcome.tick = null
    harness.setClock(T0 + 12 * 60_000)
    await jobsDo.alarm()
    expect(jobsDo.jobs.nextAt("tick")).toBe(T0 + 15 * 60_000)
  })

  // admits: ensure or schedule move a waiting job later; SQL upsert semantics
  it("ensure keeps the earlier time, and schedule takes the earlier of the two", async () => {
    const { jobsDo } = make()
    await run(jobsDo.jobs.schedule("a", T0 + 1_000))
    await run(jobsDo.jobs.ensure("a", T0 + 500))
    expect(jobsDo.jobs.nextAt("a")).toBe(T0 + 1_000)
    await run(jobsDo.jobs.ensure("b", T0 + 500))
    expect(jobsDo.jobs.nextAt("b")).toBe(T0 + 500)
    await run(jobsDo.jobs.schedule("a", T0 + 9_000))
    expect(jobsDo.jobs.nextAt("a")).toBe(T0 + 1_000)
    await run(jobsDo.jobs.schedule("a", T0 + 200))
    expect(jobsDo.jobs.nextAt("a")).toBe(T0 + 200)
  })

  // admits: a schedule landing while the job awaits is overwritten by the run's answer; interleaving
  it("keeps a schedule that lands while the job runs, and honours a cancel", async () => {
    const { harness, jobsDo } = make()
    jobsDo.outcome.a = T0 + 60_000
    jobsDo.during = (self) => Effect.runSync(self.jobs.schedule("a", T0 + 5_000))
    await run(jobsDo.jobs.schedule("a", T0))
    await jobsDo.alarm()
    expect(jobsDo.jobs.nextAt("a")).toBe(T0 + 5_000)

    jobsDo.during = (self) => Effect.runSync(self.jobs.cancel("a"))
    harness.setClock(T0 + 5_000)
    await jobsDo.alarm()
    expect(jobsDo.jobs.nextAt("a")).toBeNull()
  })

  // admits: jobs cannot join the caller's write transaction; SyncEffect composition
  it("schedules inside SyncTx and rolls back with it", async () => {
    const { jobsDo } = make()
    const jobs = jobsDo.jobs
    const failed = Effect.runSyncExit(
      jobsDo.db.transactSync(function* () {
        yield* jobs.schedule("a", T0 + 1_000)
        return yield* SyncTx.fail(new Error("abort"))
      })
    )
    expect(Exit.isFailure(failed)).toBe(true)
    expect(jobsDo.jobs.nextAt("a")).toBeNull()

    Effect.runSync(jobsDo.db.transactSync(function* () {
      yield* jobs.schedule("a", T0 + 1_000)
    }))
    expect(jobsDo.jobs.nextAt("a")).toBe(T0 + 1_000)
  })

  // admits: an unknown name, a bad cron or a non-finite time writes a row no handler can run; runtime input
  it("refuses an unregistered name, a bad cron and a non-finite time", () => {
    const { jobsDo } = make()
    const loose = jobsDo.jobs as HeraJobScheduler<string>
    for (const effect of [
      loose.schedule("nope", T0),
      jobsDo.jobs.schedule("a", "not a cron"),
      jobsDo.jobs.schedule("a", Number.NaN),
    ]) {
      const exit = Effect.runSyncExit(effect)
      expect(Exit.isFailure(exit) && HeraJobError.is(exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : undefined)).toBe(true)
    }
    expect(jobsDo.jobs.earliestAt()).toBeNull()
  })

  // admits: a row left by another build loops forever; runtime storage
  it("drops a row no handler is registered for, and logs it", async () => {
    const logs: Array<Record<string, unknown>> = []
    const harness = makeTestDurableObjectState({ idName: "jobs", initialTimeMs: T0 })
    const jobsDo = new JobsDO(harness.state, {}, { sink: (_line, entry) => logs.push(entry) })
    await run(jobsDo.jobs.schedule("a", T0 + 1))
    harness.sqliteDb.exec(`INSERT INTO _hera_jobs (name, due_at, gen, cron) VALUES ('gone', ${T0}, 1, NULL)`)
    harness.setClock(T0 + 1)
    await jobsDo.alarm()
    expect(logs.some((entry) => entry.msg === "hera.jobs.unknown")).toBe(true)
    expect(jobsDo.jobs.nextAt("gone" as "a")).toBeNull()
    expect(jobsDo.fires.map(([name]) => name)).toEqual(["a"])
  })

  // admits: a purge during an awaited job re-creates storage; runtime purge
  it("leaves no row and no alarm when storage is purged during a job", async () => {
    const { harness, jobsDo } = make()
    jobsDo.outcome.a = T0 + 60_000
    jobsDo.during = () => {
      harness.state.storage.deleteAll()
    }
    await run(jobsDo.jobs.schedule("a", T0))
    const callsBefore = harness.setAlarmCalls.length
    await jobsDo.alarm()
    expect(jobsDo.isInitialized()).toBe(false)
    expect(harness.setAlarmCalls).toHaveLength(callsBefore)
  })
})

describe("jobs on TenantDurableObject", () => {
  class OrgDO extends Hera.TenantDurableObject.configure({ service: "org-jobs", alarmErrorBackoffMs: BACKOFF_MS }) {
    static readonly jobs = {
      sweep: (_nowMs: number, self: OrgDO) => Effect.sync(() => {
        self.swept += 1
        return null
      }),
    } satisfies HeraJobRegistry<OrgDO>
    swept = 0
    hookCalls = 0
    protected override onDomainAlarm() {
      this.hookCalls += 1
      throw new Error("hook down")
    }
  }

  // admits: a failing onDomainAlarm starves due jobs in the same pass; control flow
  it("runs due jobs when onDomainAlarm fails, and keeps both armed", async () => {
    const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
    const org = new OrgDO(harness.state, {})
    await run(org.scheduleDomainAlarm(T0))
    await run(org.jobs.schedule("sweep", T0))
    await org.alarm()
    expect(org.hookCalls).toBe(1)
    expect(org.swept).toBe(1)
    expect(org.getDomainAlarmAt()).toBe(T0 + BACKOFF_MS)
    expect(harness.getScheduledAlarm()).toBe(T0 + BACKOFF_MS)
  })
})

describe("jobs.adoptDomainAlarm", () => {
  class LegacyDO extends Hera.KeyedDurableObject.configure({ service: "jobs-test" }) {
    static hookCalls = 0
    protected override onDomainAlarm() {
      LegacyDO.hookCalls += 1
    }
  }

  function legacySlot(atMs: number) {
    const harness = makeTestDurableObjectState({ idName: "jobs", initialTimeMs: T0 })
    Effect.runSync(new LegacyDO(harness.state, {}).scheduleDomainAlarm(atMs))
    return { harness, jobsDo: new JobsDO(harness.state, {}) }
  }

  // admits: a slot armed by the pre-jobs class is lost or still fires onDomainAlarm after the move; storage across class versions
  it("moves a slot armed under an onDomainAlarm class onto the job, and clears it", async () => {
    LegacyDO.hookCalls = 0
    const { harness, jobsDo } = legacySlot(T0 + 5_000)
    expect(jobsDo.getDomainAlarmAt()).toBe(T0 + 5_000)

    Effect.runSync(jobsDo.jobs.adoptDomainAlarm("a"))
    expect(jobsDo.jobs.nextAt("a")).toBe(T0 + 5_000)
    expect(jobsDo.getDomainAlarmAt()).toBeNull()
    expect(harness.getScheduledAlarm()).toBe(T0 + 5_000)

    harness.setClock(T0 + 5_000)
    await jobsDo.alarm()
    expect(jobsDo.fires).toEqual([["a", T0 + 5_000]])
    expect(LegacyDO.hookCalls).toBe(0)
  })

  // admits: adopting moves a waiting job later, or keeps a later row over an earlier slot; SQL upsert semantics
  it("keeps the earlier of the slot and an existing row", () => {
    const later = legacySlot(T0 + 5_000).jobsDo
    Effect.runSync(later.jobs.schedule("a", T0 + 1_000))
    Effect.runSync(later.jobs.adoptDomainAlarm("a"))
    expect(later.jobs.nextAt("a")).toBe(T0 + 1_000)
    expect(later.getDomainAlarmAt()).toBeNull()

    const earlier = legacySlot(T0 + 2_000).jobsDo
    Effect.runSync(earlier.jobs.schedule("a", T0 + 9_000))
    Effect.runSync(earlier.jobs.adoptDomainAlarm("a"))
    expect(earlier.jobs.nextAt("a")).toBe(T0 + 2_000)
    expect(earlier.getDomainAlarmAt()).toBeNull()
  })

  // admits: the move cannot join the caller's transaction, or half-commits on rollback; SyncEffect composition
  it("composes inside transactSync and rolls back with it", () => {
    const { jobsDo } = legacySlot(T0 + 5_000)
    const jobs = jobsDo.jobs
    const failed = Effect.runSyncExit(
      jobsDo.db.transactSync(function* () {
        yield* jobs.adoptDomainAlarm("a")
        return yield* SyncTx.fail(new Error("abort"))
      })
    )
    expect(Exit.isFailure(failed)).toBe(true)
    expect(jobsDo.getDomainAlarmAt()).toBe(T0 + 5_000)
    expect(jobsDo.jobs.nextAt("a")).toBeNull()

    Effect.runSync(jobsDo.db.transactSync(function* () {
      yield* jobs.adoptDomainAlarm("a")
    }))
    expect(jobsDo.jobs.nextAt("a")).toBe(T0 + 5_000)
    expect(jobsDo.getDomainAlarmAt()).toBeNull()
  })

  // admits: adopting with no slot writes a row, arms an alarm or initialises an empty object; runtime storage
  it("is a no-op with no slot, and refuses an unregistered name", () => {
    const { harness, jobsDo } = make()
    Effect.runSync(jobsDo.jobs.adoptDomainAlarm("a"))
    expect(jobsDo.isInitialized()).toBe(false)
    expect(harness.setAlarmCalls).toHaveLength(0)

    Effect.runSync(jobsDo.jobs.schedule("b", T0 + 1_000))
    Effect.runSync(jobsDo.jobs.adoptDomainAlarm("a"))
    expect(jobsDo.jobs.nextAt("a")).toBeNull()

    const exit = Effect.runSyncExit((jobsDo.jobs as HeraJobScheduler<string>).adoptDomainAlarm("nope"))
    expect(Exit.isFailure(exit) && HeraJobError.is(exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : undefined)).toBe(true)
  })
})
