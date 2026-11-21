import { clampAlarmAt } from "./alarm-slot.js"

/**
 * Runs one composite pass for a host that owns the platform alarm, and answers the time
 * to wake next: the earlier of the time the pass would have armed and the composite time pending once
 * the pass has settled, or `null` when neither exists or storage was purged during the pass.
 *
 * Invariants:
 *  - It arms nothing. The pass's `arm` is a recorder.
 *  - Slot syncs are deferred while the pass runs (`deferArms` is held until it settles, even on a
 *    throw), so the answer is the pass's only arm. Under an `agents` `Lifecycle`, a same-id push made
 *    while the host job dispatches would otherwise supersede the job's `{ rescheduleAt }`.
 *  - A write the hold deferred is never lost: the composite time is read again after the hold is
 *    released (a write landing after the pass's own last read, through an Effect scheduler yield, is
 *    in it), and the earlier time wins. An earlier answer costs at most one extra wake.
 */
export async function answerCompositePass(deps: {
  readonly isInitialized: () => boolean
  readonly deferArms: <A>(run: () => Promise<A>) => Promise<A>
  readonly runPass: (arm: (atMs: number) => Promise<void>) => Promise<void>
  /** The composite time pending in storage now, or `null`. */
  readonly pendingAt: () => number | null
  readonly now: () => number
}): Promise<number | null> {
  if (!deps.isInitialized()) {
    return null
  }
  let answer: number | null = null
  await deps.deferArms(() =>
    deps.runPass(async (atMs) => {
      answer = atMs
    })
  )
  if (!deps.isInitialized()) {
    return null
  }
  const pendingAt = deps.pendingAt()
  const times = [answer, pendingAt === null ? null : clampAlarmAt(pendingAt, deps.now())].filter(
    (at): at is number => at !== null
  )
  return times.length === 0 ? null : Math.min(...times)
}
