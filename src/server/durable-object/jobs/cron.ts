import * as Cron from "effect/Cron"
import * as Result from "effect/Result"

/** Cron expressions are evaluated in UTC, so a schedule does not move with the host's zone. */
const CRON_TIME_ZONE = "UTC"

/** Parses a 5- or 6-field cron expression; `undefined` when it is not one. */
export function parseCron(expression: string): Cron.Cron | undefined {
  return Result.getOrUndefined(Cron.parse(expression, CRON_TIME_ZONE))
}

/** The cron's next tick strictly after `nowMs`, in epoch milliseconds. */
export function nextCronAt(cron: Cron.Cron, nowMs: number): number {
  return Cron.next(cron, nowMs).getTime()
}

/** The next tick of a stored cron expression, or `null` for a row with none (or an unparsable one). */
export function nextStoredCronAt(expression: string | null, nowMs: number): number | null {
  const cron = expression === null ? undefined : parseCron(expression)
  return cron === undefined ? null : nextCronAt(cron, nowMs)
}
