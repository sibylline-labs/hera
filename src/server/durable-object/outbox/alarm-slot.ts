import * as Effect from "effect/Effect"
import { type HeraLogger } from "../../../core/logger/index.js"
import { summarizeRedactedReason, wrapSqlError } from "../sql/storage-adapter.js"
import { SyncTx } from "../sql/sync-tx.js"
import { HeraSqlError, type SyncEffect } from "../types.js"
import {
  clearDomainAlarmMeta,
  readDomainAlarmAt,
  readNextOutboxRetryAt,
  upsertDomainAlarmMeta,
} from "./store.js"
import { readEarliestJobAt } from "../jobs/store.js"
import type { AlarmDriver } from "../alarm-driver.js"
import type { HeraOutboxOrdering } from "./types.js"

/** Receives a rejected arm that the caller cannot await. */
export type AlarmArmFailureHandler = (err: unknown) => void

/**
 * The single platform-alarm floor: workerd refuses a time `<= 0`, and a past time only fires
 * at once, so every `setAlarm` Hera issues is at least `now + 1`.
 */
export function clampAlarmAt(atMs: number, nowMs: number): number {
  return Math.max(Math.round(atMs), nowMs + 1)
}

/** The earliest of the outbox's next send, the domain slot and the earliest named job. */
export function computeCompositeAlarmAt(
  sqlStorage: SqlStorage,
  ordering: HeraOutboxOrdering
): number | null {
  const times = [
    readNextOutboxRetryAt(sqlStorage, ordering),
    readDomainAlarmAt(sqlStorage),
    readEarliestJobAt(sqlStorage),
  ].filter((at): at is number => at !== null)
  return times.length === 0 ? null : Math.min(...times)
}

/**
 * Arms the composite time through the driver from synchronous code. The `set` promise cannot be
 * awaited inside a `SyncEffect`, so its rejection goes to `onArmFailure`, never unhandled; the wake
 * re-arm heals the lost alarm. While `armsDeferred()` holds (a `runCompositePass` is running), it
 * arms nothing: the pass answers the composite time it reads last, which covers this write.
 */
export function syncCompositeAlarmSlot(deps: AlarmSlotDeps, nowMs: number): number | null {
  const nextAlarmAt = computeCompositeAlarmAt(deps.storage.sql, deps.ordering)
  if (nextAlarmAt !== null && !deps.armsDeferred()) {
    try {
      Promise.resolve(deps.driver().set(clampAlarmAt(nextAlarmAt, nowMs))).catch(deps.onArmFailure)
    } catch (err) {
      deps.onArmFailure(err)
    }
  }
  return nextAlarmAt
}

/**
 * What a slot write needs: the storage its SQL lives in, the clock, the object's `AlarmDriver`
 * (resolved on use, so a subclass's driver can depend on its own fields), whether arms are deferred,
 * and where a lost arm is reported.
 */
export interface AlarmSlotDeps {
  readonly storage: DurableObjectStorage
  readonly now: () => number
  readonly driver: () => AlarmDriver
  readonly armsDeferred: () => boolean
  readonly onArmFailure: AlarmArmFailureHandler
  /** The outbox's ordering, which decides when it can next send. */
  readonly ordering: HeraOutboxOrdering
}

/**
 * On wake, arms the composite time unless an alarm is already set for then or earlier, so rows
 * or a domain slot whose platform alarm was lost do not wait for the next write.
 * Writes nothing on an uninitialised object. It yields one microtask first: it starts from the
 * constructor, before a subclass's fields (which its driver may read) are initialised.
 */
export async function rearmCompositeAlarmOnWake(
  deps: AlarmSlotDeps,
  isInitialized: () => boolean
): Promise<void> {
  await Promise.resolve()
  if (!isInitialized()) {
    return
  }
  const compositeAt = computeCompositeAlarmAt(deps.storage.sql, deps.ordering)
  if (compositeAt === null) {
    return
  }
  const targetAt = clampAlarmAt(compositeAt, deps.now())
  const driver = deps.driver()
  const currentAt = await driver.get()
  if (currentAt !== null && currentAt <= targetAt) {
    return
  }
  await driver.set(targetAt)
}

export function scheduleDomainAlarmEffect(
  deps: AlarmSlotDeps,
  atMs: number,
  ensureStorage: () => void
): SyncEffect<void, HeraSqlError> {
  return SyncTx.try({
    try: () => {
      if (!Number.isFinite(atMs)) {
        throw new HeraSqlError({
          operation: "scheduleDomainAlarm",
          reason: "Domain alarm timestamp must be a finite number",
        })
      }
      ensureStorage()
      const nowMs = deps.now()
      upsertDomainAlarmMeta(deps.storage, Math.round(atMs), nowMs)
      syncCompositeAlarmSlot(deps, nowMs)
    },
    catch: wrapSqlError("scheduleDomainAlarm", "Failed to schedule domain alarm"),
  })
}

export function cancelDomainAlarmEffect(
  deps: AlarmSlotDeps,
  isInitialized: () => boolean
): SyncEffect<void, HeraSqlError> {
  return SyncTx.try({
    try: () => {
      if (!isInitialized()) {
        return
      }
      clearDomainAlarmMeta(deps.storage)
      syncCompositeAlarmSlot(deps, deps.now())
    },
    catch: wrapSqlError("cancelDomainAlarm", "Failed to cancel domain alarm"),
  })
}

/** Logs a platform-alarm failure no caller can see (`hera.alarm.arm_failed`, `hera.alarm.rearm_failed`). */
export function alarmFailureLogger(options: {
  readonly logger: HeraLogger
  readonly logFields: Readonly<Record<string, unknown>>
  readonly service: string
}): (msg: "hera.alarm.arm_failed" | "hera.alarm.rearm_failed") => AlarmArmFailureHandler {
  return (msg) => (err) => {
    // hera-allow: raw-effect-run
    Effect.runFork(
      options.logger.error(msg, {
        ...options.logFields,
        service: options.service,
        reason: summarizeRedactedReason(err, "The alarm arm failed"),
      })
    )
  }
}
