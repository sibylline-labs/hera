import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { type HeraLogger } from "../../../core/logger/index.js"
import { summarizeRedactedReason } from "../sql/storage-adapter.js"
import { HeraSqlError, type SyncEffect } from "../types.js"
import { type HeraOutboxDrainResult, type HeraOutboxOrdering } from "./types.js"
import { clampAlarmAt, computeCompositeAlarmAt } from "./alarm-slot.js"
import { liftSinkOrHookResult } from "./sink-result.js"
import { clearDomainAlarmMeta, readDomainAlarmAt } from "./store.js"

/**
 * One composite alarm pass: drain the outbox, run the domain hook when its slot is due, run the
 * named jobs that are due, re-arm.
 *
 * Invariants:
 *  - A failing hook leaves the domain slot due at `now + alarmErrorBackoffMs`, so the next alarm
 *    calls it again.
 *  - The hook's returned time never moves a slot armed while the hook awaited later: the slot is
 *    cleared before the hook, so any slot present after it was armed mid-pass, and the earlier wins.
 *  - Storage purged during the pass (`deleteAll`) is never touched again: no slot, no arm.
 *  - Every arm is clamped to `>= now + 1`, and goes through `arm` (the object's `AlarmDriver`, or the
 *    recorder `runCompositePass` answers from).
 *  - A failing hook does not starve the jobs: they run, then the hook's cause reaches the recovery.
 */
export function runCompositeAlarmEffect(options: {
  /** The storage the pass's SQL lives in; never its platform alarm. */
  readonly storage: DurableObjectStorage
  /** Arms the next composite time. A rejection in the success arm reaches the recovery arm. */
  readonly arm: (atMs: number) => Promise<void>
  readonly logFields: Readonly<Record<string, unknown>>
  readonly service: string
  readonly nowMs: number
  readonly alarmErrorBackoffMs: number
  readonly logger: HeraLogger
  readonly drainOutbox: (nowMs: number) => Effect.Effect<HeraOutboxDrainResult, never, never>
  readonly onDomainAlarm: (
    nowMs: number
  ) => Effect.Effect<number | void, unknown, never> | Promise<number | void> | number | void
  readonly scheduleDomainAlarm: (atMs: number) => SyncEffect<void, HeraSqlError>
  /** One pass over the named jobs due at `nowMs`; a storage failure is its only failure. */
  readonly runDueJobs: (nowMs: number) => Effect.Effect<void, HeraSqlError, never>
  /** False once storage was purged (`deleteAll`): nothing is left to re-arm for. */
  readonly isInitialized: () => boolean
  readonly ordering: HeraOutboxOrdering
}): Effect.Effect<void, never, never> {
  const { storage, nowMs } = options
  const armDomainEarliest = (atMs: number): SyncEffect<void, HeraSqlError> => {
    const armedMidPass = readDomainAlarmAt(storage.sql)
    return options.scheduleDomainAlarm(
      armedMidPass !== null ? Math.min(armedMidPass, atMs) : atMs
    )
  }

  return Effect.gen(function* () {
    yield* options.drainOutbox(nowMs)
    if (!options.isInitialized()) {
      return
    }

    let hookFailure: Cause.Cause<unknown> | undefined
    const domainDueAt = readDomainAlarmAt(storage.sql)
    if (domainDueAt !== null && domainDueAt <= nowMs) {
      clearDomainAlarmMeta(storage)
      const hookExit = yield* Effect.exit(
        Effect.try({
          try: () => options.onDomainAlarm(nowMs),
          catch: (err) => err,
        }).pipe(Effect.flatMap((res) => liftSinkOrHookResult(res)))
      )
      if (!options.isInitialized()) {
        return
      }
      if (hookExit._tag === "Failure") {
        yield* armDomainEarliest(nowMs + options.alarmErrorBackoffMs)
        hookFailure = hookExit.cause
      } else if (typeof hookExit.value === "number" && Number.isFinite(hookExit.value)) {
        yield* armDomainEarliest(hookExit.value)
      }
    }

    yield* options.runDueJobs(nowMs)
    if (!options.isInitialized()) {
      return
    }
    if (hookFailure !== undefined) {
      return yield* Effect.failCause(hookFailure)
    }

    const nextCompositeAt = computeCompositeAlarmAt(storage.sql, options.ordering)
    if (nextCompositeAt !== null) {
      yield* Effect.tryPromise({
        try: () => options.arm(clampAlarmAt(nextCompositeAt, nowMs)),
        catch: (err) => err,
      })
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const redactedReason = summarizeRedactedReason(
          Cause.squash(cause),
          "Unhandled defect in a Hera Durable Object alarm"
        )
        yield* options.logger.error("hera.alarm.defect", {
          ...options.logFields,
          service: options.service,
          reason: redactedReason,
        })
        if (!options.isInitialized()) {
          return
        }

        const fallbackAt = nowMs + options.alarmErrorBackoffMs
        const pendingAt = computeCompositeAlarmAt(storage.sql, options.ordering)
        const recoveryAt =
          pendingAt !== null ? Math.min(clampAlarmAt(pendingAt, nowMs), fallbackAt) : fallbackAt

        yield* Effect.tryPromise({
          try: () => options.arm(recoveryAt),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.void))
      })
    )
  )
}
