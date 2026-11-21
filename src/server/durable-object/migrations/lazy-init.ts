import { hasSqlTable } from "../sql/storage-adapter.js"
import { type HeraLegacyMigrationLedger, type HeraMigration, HeraSqlError } from "../types.js"
import { hasLegacyLedger, validateLegacyLedger } from "./legacy-ledger.js"
import {
  applyStorageInitialization,
  HERA_MIGRATIONS_TABLE,
  runWithBlockConcurrency,
  validateMigrationDescriptors,
} from "./runner.js"

/**
 * Lazy storage initialisation for a tenant Durable Object.
 *
 * Invariants:
 *  - Initialised means `_hera_migrations` is a table. It is probed on every call and never cached,
 *    so a `ctx.storage.deleteAll()` is seen at once and the next write initialises again.
 *  - Construction and reads write nothing to an object that has no state. On wake, an object that
 *    already holds `_hera_migrations`, the legacy ledger or harness-deferred seed SQL is brought to
 *    the end of its migrations under `blockConcurrencyWhile`, so its reads see the current schema.
 *  - Every initialisation is synchronous from probe to commit, so no other event can interleave:
 *    the guarantee `blockConcurrencyWhile` gives the wake path.
 */
export interface HeraStorageInitializer {
  readonly isInitialized: () => boolean
  /** Initialises inside a `transactionSync` the caller already holds; never opens one. */
  readonly ensureInline: () => void
  /** Initialises in its own `transactionSync` when the object is not yet initialised. */
  readonly ensure: () => void
}

export function createStorageInitializer(options: {
  readonly ctx: DurableObjectState
  readonly migrations: ReadonlyArray<HeraMigration>
  readonly now: () => number
  readonly legacyLedger?: HeraLegacyMigrationLedger | undefined
}): HeraStorageInitializer {
  const { ctx, now } = options
  const sorted = validateMigrationDescriptors(options.migrations)
  const legacyLedger = validateLegacyLedger(options.legacyLedger)

  const isInitialized = (): boolean => hasSqlTable(ctx.storage.sql, HERA_MIGRATIONS_TABLE)
  const ensureInline = (): void => {
    if (!isInitialized()) {
      applyStorageInitialization(ctx, sorted, now, legacyLedger)
    }
  }
  const ensure = (): void => {
    if (!isInitialized()) {
      ctx.storage.transactionSync(() => {
        applyStorageInitialization(ctx, sorted, now, legacyLedger)
      })
    }
  }

  const hasPendingSeed = (): boolean =>
    ((ctx as { __heraPendingSeedSql?: ReadonlyArray<string> }).__heraPendingSeedSql?.length ?? 0) > 0

  runWithBlockConcurrency(ctx, () => {
    if (isInitialized() || hasLegacyLedger(ctx.storage.sql, legacyLedger) || hasPendingSeed()) {
      ctx.storage.transactionSync(() => {
        applyStorageInitialization(ctx, sorted, now, legacyLedger)
      })
    }
  })

  return { isInitialized, ensureInline, ensure }
}

/**
 * Refuses to initialise once `purgeStorage()` has marked the object purged. `deleteAll`
 * leaves no `_hera_migrations`, so without this the next write would re-create every table and the
 * rows would outlive the purge: the deferred `abort` resets the object, not its storage.
 */
export function guardInitAfterPurge(
  init: HeraStorageInitializer,
  isPurged: () => boolean
): HeraStorageInitializer {
  const refuseWhenPurged = (): void => {
    if (isPurged()) {
      throw new HeraSqlError({
        operation: "initialize",
        reason: "Storage was purged; not re-initialising",
      })
    }
  }
  return {
    isInitialized: init.isInitialized,
    ensureInline: () => {
      refuseWhenPurged()
      init.ensureInline()
    },
    ensure: () => {
      refuseWhenPurged()
      init.ensure()
    },
  }
}

/**
 * Refuses to initialise while the alarm runs. `alarm()` starts only on an initialised
 * object, so an uninitialised one mid-alarm was purged (`deleteAll`) while the pass awaited; a
 * write then must not re-create every table.
 */
export function guardInitDuringAlarm(
  init: HeraStorageInitializer,
  isAlarmRunning: () => boolean
): HeraStorageInitializer {
  const refuseWhenPurged = (): void => {
    if (isAlarmRunning() && !init.isInitialized()) {
      throw new HeraSqlError({
        operation: "initialize",
        reason: "Storage was purged while the alarm was running; not re-initialising",
      })
    }
  }
  return {
    isInitialized: init.isInitialized,
    ensureInline: () => {
      refuseWhenPurged()
      init.ensureInline()
    },
    ensure: () => {
      refuseWhenPurged()
      init.ensure()
    },
  }
}
