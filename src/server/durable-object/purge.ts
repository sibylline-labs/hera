import * as Effect from "effect/Effect"
import type { AlarmDriver } from "./alarm-driver.js"
import { liftSinkOrHookResult } from "./outbox/sink-result.js"

/** What `beforePurge` may answer: an Effect, a Promise or nothing. */
export type BeforePurgeResult = Effect.Effect<void, unknown, never> | Promise<void> | void

/**
 * Empties a Hera Durable Object, in this order:
 *  1. clear the driver's alarm, so a failure past this point leaves nothing to wake and a retry
 *     finishes;
 *  2. `beforePurge`, the host's teardown (a Pi harness disposes here, since a live harness keeps
 *     running against dropped tables). A failure rejects the purge with the data intact and no alarm
 *     armed, so the caller retries it (a purge door that answers `{ ok: false }` is retried);
 *  3. mark the object purged, with no await before `deleteAll` is called: from here `this.db` refuses
 *     every statement and every re-initialisation, so a request that awaited across the purge cannot
 *     re-create the storage it empties. `beforePurge` runs before the mark, so a host
 *     draining its in-flight writes there still writes;
 *  4. `ctx.storage.deleteAll()`;
 *  5. `ctx.abort()` on the next macrotask. A synchronous abort rejects the caller of an RPC that has
 *     already succeeded, so a purge door that retries on failure would never settle. A request that
 *     interleaves in that one-macrotask window is refused by the mark.
 */
export async function purgeDurableObjectStorage(deps: {
  readonly ctx: DurableObjectState
  readonly driver: AlarmDriver
  readonly beforePurge: () => BeforePurgeResult
  readonly markPurged: () => void
}): Promise<void> {
  await deps.driver.clear()
  // hera-allow: raw-effect-run
  await Effect.runPromise(liftSinkOrHookResult(deps.beforePurge()))
  deps.markPurged()
  await deps.ctx.storage.deleteAll()
  setTimeout(() => deps.ctx.abort("hera.purge"), 0)
}
