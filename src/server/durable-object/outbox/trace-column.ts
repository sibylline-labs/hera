const OUTBOX_TABLES = ["_hera_outbox", "_hera_outbox_dead_letter"] as const

function hasColumn(sql: SqlStorage, table: string, column: string): boolean {
  return sql
    .exec(`PRAGMA table_info(${table})`)
    .toArray()
    .some((row) => (row as { readonly name?: unknown }).name === column)
}

/**
 * Adds the nullable `traceparent` column to an outbox table created before it existed. Idempotent:
 * SQLite refuses a second `ADD COLUMN`, so each table is probed first. Rows already stored keep
 * NULL; only new writes carry a value. The caller holds the init transaction.
 */
export function ensureOutboxTraceColumns(sql: SqlStorage): void {
  for (const table of OUTBOX_TABLES) {
    if (!hasColumn(sql, table, "traceparent")) {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN traceparent TEXT`).toArray()
    }
  }
}
