import { hasSqlTable } from "../sql/storage-adapter.js"
import {
  type HeraLegacyMigrationLedger,
  type HeraMigration,
  HeraMigrationError,
} from "../types.js"

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const LEGACY_LEDGER_LABEL = "<legacy-ledger>"

/**
 * Checks a legacy ledger's table and column names before any of them reaches SQL text: both are
 * interpolated as identifiers, so only plain identifiers are accepted.
 */
export function validateLegacyLedger(
  ledger: HeraLegacyMigrationLedger | undefined
): HeraLegacyMigrationLedger | undefined {
  if (ledger === undefined) {
    return undefined
  }
  const column = ledger.versionColumn ?? "version"
  for (const identifier of [ledger.table, column]) {
    if (typeof identifier !== "string" || !SQL_IDENTIFIER.test(identifier)) {
      throw new HeraMigrationError({
        version: 0,
        migrationName: LEGACY_LEDGER_LABEL,
        reason: "Legacy migration ledger table and column must be plain SQL identifiers",
      })
    }
  }
  return { table: ledger.table, versionColumn: column }
}

/** Whether the object holds a legacy ledger, i.e. it was written before it moved onto Hera. */
export function hasLegacyLedger(
  sqlStorage: SqlStorage,
  ledger: HeraLegacyMigrationLedger | undefined
): boolean {
  return ledger !== undefined && hasSqlTable(sqlStorage, ledger.table)
}

/**
 * Records every version the legacy ledger holds in `_hera_migrations`, under the declared
 * migration's name, so the runner skips it and never re-runs a non-idempotent statement. Runs only
 * while `_hera_migrations` is being created; the legacy table is left as it is.
 */
export function adoptLegacyLedger(
  sqlStorage: SqlStorage,
  ledger: HeraLegacyMigrationLedger | undefined,
  sorted: ReadonlyArray<HeraMigration>,
  appliedAt: number
): void {
  if (ledger === undefined || !hasSqlTable(sqlStorage, ledger.table)) {
    return
  }
  const column = ledger.versionColumn ?? "version"
  const rows = sqlStorage
    .exec(`SELECT "${column}" AS version FROM "${ledger.table}" ORDER BY "${column}" ASC`)
    .toArray() as Array<{ version: number | null }>
  const declared = new Map(sorted.map((m) => [m.version, m]))
  for (const row of rows) {
    const version = Number(row.version)
    const migration = declared.get(version)
    if (migration === undefined) {
      throw new HeraMigrationError({
        version: Number.isFinite(version) ? version : 0,
        migrationName: LEGACY_LEDGER_LABEL,
        reason: `Legacy ledger '${ledger.table}' records version ${String(row.version)}, which no declared migration has`,
      })
    }
    sqlStorage
      .exec(
        "INSERT INTO _hera_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        appliedAt
      )
      .toArray()
  }
}
