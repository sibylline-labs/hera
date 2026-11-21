/**
 * The one owner of a Hera Durable Object's platform alarm.
 *
 * Every arm, read and clear the DO spine makes (the composite alarm, the post-commit slot sync, the
 * wake re-arm, `purgeStorage`) goes through the object's `AlarmDriver`, and the `hera-alarm-via-driver`
 * lint keeps every other module in `src/` off `setAlarm` / `getAlarm` / `deleteAlarm`.
 *
 * `StorageAlarmDriver`, the default, is the platform alarm itself. A host that hands the alarm to
 * another owner overrides `createAlarmDriver()`. For example, an `agents` `Lifecycle` that owns
 * `alarm()` and re-arms it from its own job queue gets a driver that keeps one host job, and that job
 * runs `runCompositePass()`.
 *
 * Invariants:
 *  - `set(atMs)` replaces any earlier arm. Hera clamps every time it passes to `>= now + 1` first.
 *  - `get()` answers the armed time or `null`. `clear()` leaves nothing armed.
 *  - A driver keeps no state of its own that a wake must restore: the composite time is always
 *    recomputed from SQLite, so an object can change drivers (or revert to the default) between wakes.
 */
export interface AlarmDriver {
  readonly set: (atMs: number) => Promise<void>
  readonly get: () => Promise<number | null>
  readonly clear: () => Promise<void>
}

/** The platform alarm of the object's own storage: the default `AlarmDriver`. */
export class StorageAlarmDriver implements AlarmDriver {
  constructor(private readonly storage: DurableObjectStorage) {}

  readonly set = (atMs: number): Promise<void> => this.storage.setAlarm(atMs)

  readonly get = (): Promise<number | null> => this.storage.getAlarm()

  readonly clear = (): Promise<void> => this.storage.deleteAlarm()
}
