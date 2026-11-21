import { HERA_INTERNAL_DDL } from "../outbox/schema.js"
import { ensureOutboxTraceColumns } from "../outbox/trace-column.js"
import { hasSqlTable, summarizeRedactedReason } from "../sql/storage-adapter.js"
import {
  type HeraAppliedMigration,
  type HeraLegacyMigrationLedger,
  type HeraMigration,
  HeraMigrationError,
} from "../types.js"
import { adoptLegacyLedger } from "./legacy-ledger.js"

export const HERA_MIGRATIONS_TABLE = "_hera_migrations"

export function validateMigrationDescriptors(
  migrations: ReadonlyArray<HeraMigration>
): ReadonlyArray<HeraMigration> {
  const seenVersions = new Set<number>()
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new HeraMigrationError({
        version: m.version,
        migrationName: m.name || "<unnamed>",
        reason: "Migration version must be a positive integer",
      })
    }
    if (typeof m.name !== "string" || m.name.trim().length === 0) {
      throw new HeraMigrationError({
        version: m.version,
        migrationName: "<empty>",
        reason: "Migration name must be a non-empty string",
      })
    }
    if (seenVersions.has(m.version)) {
      throw new HeraMigrationError({
        version: m.version,
        migrationName: m.name,
        reason: `Duplicate migration version ${m.version}`,
      })
    }
    seenVersions.add(m.version)
  }

  return [...migrations].sort((a, b) => a.version - b.version)
}

/**
 * Creates the internal tables, adopts a legacy ledger when `_hera_migrations` is new, applies every
 * pending migration and any harness-deferred seed. Runs no transaction of its own: the caller holds
 * one, so a rolled-back caller rolls the initialisation back with it.
 */
export function applyStorageInitialization(
  ctx: DurableObjectState,
  sorted: ReadonlyArray<HeraMigration>,
  now: () => number,
  legacyLedger?: HeraLegacyMigrationLedger
): void {
  const ledgerIsNew = !hasSqlTable(ctx.storage.sql, HERA_MIGRATIONS_TABLE)
  for (const ddl of HERA_INTERNAL_DDL) {
    ctx.storage.sql.exec(ddl).toArray()
  }
  ensureOutboxTraceColumns(ctx.storage.sql)

  const appliedAt = now()
  if (ledgerIsNew) {
    adoptLegacyLedger(ctx.storage.sql, legacyLedger, sorted, appliedAt)
  }

  const existingRows = ctx.storage.sql
    .exec(
      "SELECT version, name, applied_at FROM _hera_migrations ORDER BY version ASC"
    )
    .toArray() as Array<{
    version: number
    name: string
    applied_at: number
  }>

  const appliedByVersion = new Map<number, string>()
  for (const row of existingRows) {
    appliedByVersion.set(Number(row.version), String(row.name))
  }

  for (const migration of sorted) {
    const recordedName = appliedByVersion.get(migration.version)
    if (recordedName !== undefined) {
      if (recordedName !== migration.name) {
        throw new HeraMigrationError({
          version: migration.version,
          migrationName: migration.name,
          reason: `Migration version ${migration.version} was already applied with name '${recordedName}'`,
        })
      }
      continue
    }

    const statements =
      typeof migration.sql === "string" ? [migration.sql] : migration.sql
    try {
      for (const stmt of statements) {
        const trimmed = stmt.trim()
        if (trimmed.length > 0) {
          ctx.storage.sql.exec(trimmed).toArray()
        }
      }
      ctx.storage.sql
        .exec(
          "INSERT INTO _hera_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          migration.version,
          migration.name,
          appliedAt
        )
        .toArray()
    } catch (err) {
      throw new HeraMigrationError({
        version: migration.version,
        migrationName: migration.name,
        reason: summarizeRedactedReason(err, "Migration SQL failed"),
      })
    }
  }

  const annotated = ctx as { __heraPendingSeedSql?: ReadonlyArray<string> | undefined }
  const pendingSeed = annotated.__heraPendingSeedSql
  if (pendingSeed && pendingSeed.length > 0) {
    annotated.__heraPendingSeedSql = undefined
    for (const stmt of pendingSeed) {
      const trimmed = stmt.trim()
      if (trimmed.length > 0) {
        ctx.storage.sql.exec(trimmed).toArray()
      }
    }
  }
}

/**
 * Runs `initialize` under `blockConcurrencyWhile`, synchronously when the state's callback ran
 * inline, and rethrows its error from the constructor.
 */
export function runWithBlockConcurrency(
  ctx: DurableObjectState,
  initialize: () => void
): void {
  let initError: unknown
  let initRan = false
  const initPromise = ctx.blockConcurrencyWhile(async () => {
    initRan = true
    try {
      initialize()
    } catch (err) {
      initError = err
      throw err
    }
  })
  if (initPromise && typeof initPromise.catch === "function") {
    initPromise.catch(() => undefined)
  }
  if (!initRan) {
    initialize()
  }
  if (initError !== undefined) {
    throw initError
  }
}

export function readAppliedMigrations(
  sqlStorage: SqlStorage
): ReadonlyArray<HeraAppliedMigration> {
  const rows = sqlStorage
    .exec(
      "SELECT version, name, applied_at FROM _hera_migrations ORDER BY version ASC"
    )
    .toArray() as Array<{
    version: number
    name: string
    applied_at: number
  }>
  return rows.map((r) => ({
    version: Number(r.version),
    name: String(r.name),
    appliedAt: Number(r.applied_at),
  }))
}
