import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { type HeraLogger } from "../../../core/logger/index.js"
import { clearDomainAlarmMeta, readDomainAlarmAt } from "../outbox/store.js"
import { liftSinkOrHookResult } from "../outbox/sink-result.js"
import { summarizeRedactedReason, wrapSqlError } from "../sql/storage-adapter.js"
import { SyncTx } from "../sql/sync-tx.js"
import { HeraSqlError, type SyncEffect } from "../types.js"
import { nextCronAt, nextStoredCronAt, parseCron } from "./cron.js"
import {
  deleteJob,
  insertJobIfAbsent,
  LEASED_GENERATION,
  leaseJob,
  lowerJobDueAt,
  readDueJobs,
  readEarliestJobAt,
  readJob,
  setJobDueAt,
  upsertJobEarliest,
} from "./store.js"
import { HeraJobError, type HeraJobRegistry, type HeraJobScheduler, type HeraJobWhen } from "./types.js"

export interface JobSchedulerDeps<Self> {
  readonly storage: DurableObjectStorage
  readonly now: () => number
  readonly registry: HeraJobRegistry<Self>
  readonly self: () => Self
  /** Initialises storage on the first write; a no-op inside a transaction that already did. */
  readonly ensureStorage: () => void
  readonly isInitialized: () => boolean
  /** Arms the composite time after a write (`syncCompositeAlarmSlot` through the object's driver). */
  readonly syncAlarmSlot: () => void
  /** How far ahead a running job is leased, and so how long after a failure it comes back. */
  readonly backoffMs: number
  readonly logger: HeraLogger
  readonly logFields: Readonly<Record<string, unknown>>
}

/**
 * Named jobs on the composite alarm. Semantics:
 *  - `schedule` never moves a job later; `ensure` never moves it at all. A job that wants a later
 *    time answers it from its handler.
 *  - A pass leases each due job (`due_at = now + backoff`, `gen = LEASED`) before running it, so a
 *    handler that fails, or an object that stops mid-job, brings the job back after the backoff.
 *  - A `schedule` landing while a handler awaits bumps `gen` off `LEASED`; the answer is then merged
 *    (earlier wins) instead of replacing it. A row `cancel` deleted mid-run stays deleted.
 *  - A cron job settles at the earlier of its answer and its next tick, so it re-arms itself.
 *  - A failing handler never escapes the pass; a storage failure does, to the alarm's recovery arm.
 *  - A purge (`deleteAll`) during a handler ends the pass with nothing written.
 *  - `adoptDomainAlarm` moves the domain slot onto a job like `schedule` (earlier wins) and clears
 *    it in the same transaction; with no slot it writes nothing.
 */
export function createJobScheduler<Self>(deps: JobSchedulerDeps<Self>): {
  readonly scheduler: HeraJobScheduler<string>
  readonly runDueJobs: (nowMs: number) => Effect.Effect<void, HeraSqlError, never>
} {
  const sql = deps.storage.sql

  const requireHandler = (operation: string, name: string): void => {
    if (!Object.hasOwn(deps.registry, name)) {
      throw new HeraJobError({ operation, job: name, reason: "No handler is registered for this job name" })
    }
  }

  const resolve = (operation: string, name: string, when: HeraJobWhen) => {
    requireHandler(operation, name)
    if (typeof when === "string") {
      const cron = parseCron(when)
      if (cron === undefined) {
        throw new HeraJobError({ operation, job: name, reason: "Not a valid cron expression" })
      }
      return { dueAt: nextCronAt(cron, deps.now()), cron: when }
    }
    if (!Number.isFinite(when)) {
      throw new HeraJobError({ operation, job: name, reason: "Job time must be a finite number" })
    }
    return { dueAt: Math.round(when), cron: null }
  }

  const write = (
    operation: "jobs.schedule" | "jobs.ensure",
    name: string,
    when: HeraJobWhen,
    apply: (name: string, dueAt: number, cron: string | null) => void
  ): SyncEffect<void, HeraJobError | HeraSqlError> =>
    SyncTx.try({
      try: () => {
        const { dueAt, cron } = resolve(operation, name, when)
        deps.ensureStorage()
        apply(name, dueAt, cron)
        deps.syncAlarmSlot()
      },
      catch: (err) =>
        HeraJobError.is(err) ? err : wrapSqlError(operation, "Failed to write job")(err),
    })

  const scheduler: HeraJobScheduler<string> = {
    schedule: (name, when) =>
      write("jobs.schedule", name, when, (n, at, cron) => upsertJobEarliest(sql, n, at, cron)),
    ensure: (name, when) =>
      write("jobs.ensure", name, when, (n, at, cron) => insertJobIfAbsent(sql, n, at, cron)),
    adoptDomainAlarm: (name) =>
      SyncTx.try({
        try: () => {
          requireHandler("jobs.adoptDomainAlarm", name)
          const slotAt = deps.isInitialized() ? readDomainAlarmAt(sql) : null
          if (slotAt === null) {
            return
          }
          upsertJobEarliest(sql, name, slotAt, null)
          clearDomainAlarmMeta(deps.storage)
          deps.syncAlarmSlot()
        },
        catch: (err) =>
          HeraJobError.is(err)
            ? err
            : wrapSqlError("jobs.adoptDomainAlarm", "Failed to adopt the domain alarm")(err),
      }),
    cancel: (name) =>
      SyncTx.try({
        try: () => {
          if (deps.isInitialized() && readJob(sql, name) !== null) {
            deleteJob(sql, name)
          }
        },
        catch: wrapSqlError("jobs.cancel", "Failed to cancel job"),
      }),
    nextAt: (name) => (deps.isInitialized() ? (readJob(sql, name)?.dueAt ?? null) : null),
    earliestAt: () => (deps.isInitialized() ? readEarliestJobAt(sql) : null),
  }

  const settle = (name: string, answer: number | null, nowMs: number): void => {
    const row = readJob(sql, name)
    if (row === null) {
      return
    }
    if (row.gen === LEASED_GENERATION) {
      const times = [answer, nextStoredCronAt(row.cron, nowMs)].filter((at): at is number => at !== null)
      if (times.length === 0) {
        deleteJob(sql, name)
      } else {
        setJobDueAt(sql, name, Math.min(...times))
      }
    } else if (answer !== null) {
      lowerJobDueAt(sql, name, answer)
    }
  }

  const storageStep = <A>(operation: string, thunk: () => A): Effect.Effect<A, HeraSqlError> =>
    Effect.try({ try: thunk, catch: wrapSqlError(operation, "Job storage operation failed") })

  const runDueJobs = (nowMs: number): Effect.Effect<void, HeraSqlError, never> =>
    Effect.gen(function* () {
      if (!deps.isInitialized()) {
        return
      }
      const due = yield* storageStep("jobs.run", () => readDueJobs(sql, nowMs))
      for (const row of due) {
        const handler = Object.hasOwn(deps.registry, row.name) ? deps.registry[row.name] : undefined
        if (handler === undefined) {
          yield* deps.logger.error("hera.jobs.unknown", { ...deps.logFields, job: row.name })
          yield* storageStep("jobs.run", () => deleteJob(sql, row.name))
          continue
        }
        yield* storageStep("jobs.lease", () => leaseJob(sql, row.name, nowMs + deps.backoffMs))
        const exit = yield* Effect.exit(
          Effect.try({ try: () => handler(nowMs, deps.self()), catch: (err) => err }).pipe(
            Effect.flatMap((res) => liftSinkOrHookResult(res)),
            Effect.flatMap((next) =>
              next === null || Number.isFinite(next)
                ? Effect.succeed(next)
                : Effect.fail(new RangeError("the job answered a time that is not finite"))
            )
          )
        )
        if (!deps.isInitialized()) {
          return
        }
        if (exit._tag === "Failure") {
          yield* deps.logger.error("hera.jobs.failed", {
            ...deps.logFields,
            job: row.name,
            reason: summarizeRedactedReason(Cause.squash(exit.cause), "Job handler failed"),
          })
          continue
        }
        yield* storageStep("jobs.settle", () => settle(row.name, exit.value, nowMs))
      }
    })

  return { scheduler, runDueJobs }
}
