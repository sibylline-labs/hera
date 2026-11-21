import { hasSqlTable } from "../sql/storage-adapter.js"

export const HERA_JOBS_TABLE = "_hera_jobs"

/**
 * The generation of a row a run holds: below the `1` a new row starts at, and no write sets it, so
 * a `schedule` that lands while the job runs is told apart from the lease.
 */
export const LEASED_GENERATION = -1

export const HERA_JOBS_DDL = `CREATE TABLE IF NOT EXISTS ${HERA_JOBS_TABLE} (
    name TEXT NOT NULL PRIMARY KEY,
    due_at INTEGER NOT NULL,
    gen INTEGER NOT NULL,
    cron TEXT
  )`

export interface JobRow {
  readonly name: string
  readonly dueAt: number
  readonly gen: number
  readonly cron: string | null
}

function rows(sql: SqlStorage, query: string, ...params: ReadonlyArray<unknown>) {
  return sql.exec(query, ...params).toArray() as Array<Record<string, unknown>>
}

function toJobRow(row: Record<string, unknown>): JobRow {
  return {
    name: String(row.name),
    dueAt: Number(row.due_at),
    gen: Number(row.gen),
    cron: row.cron === null || row.cron === undefined ? null : String(row.cron),
  }
}

export function hasJobsTable(sql: SqlStorage): boolean {
  return hasSqlTable(sql, HERA_JOBS_TABLE)
}

export function readEarliestJobAt(sql: SqlStorage): number | null {
  if (!hasJobsTable(sql)) {
    return null
  }
  const dueAt = rows(sql, `SELECT min(due_at) AS due_at FROM ${HERA_JOBS_TABLE}`)[0]?.due_at
  return typeof dueAt === "number" && Number.isFinite(dueAt) ? dueAt : null
}

export function readJob(sql: SqlStorage, name: string): JobRow | null {
  if (!hasJobsTable(sql)) {
    return null
  }
  const row = rows(sql, `SELECT name, due_at, gen, cron FROM ${HERA_JOBS_TABLE} WHERE name = ?`, name)[0]
  return row === undefined ? null : toJobRow(row)
}

/** The jobs due at `nowMs`, in order of due time then name. */
export function readDueJobs(sql: SqlStorage, nowMs: number): ReadonlyArray<JobRow> {
  if (!hasJobsTable(sql)) {
    return []
  }
  return rows(
    sql,
    `SELECT name, due_at, gen, cron FROM ${HERA_JOBS_TABLE} WHERE due_at <= ? ORDER BY due_at, name`,
    nowMs
  ).map(toJobRow)
}

/** Stores the earlier of the row's time and `dueAt` and bumps the generation; a `null` cron keeps the row's. */
export function upsertJobEarliest(sql: SqlStorage, name: string, dueAt: number, cron: string | null): void {
  rows(
    sql,
    `INSERT INTO ${HERA_JOBS_TABLE} (name, due_at, gen, cron) VALUES (?, ?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET
       due_at = min(${HERA_JOBS_TABLE}.due_at, excluded.due_at),
       gen = ${HERA_JOBS_TABLE}.gen + 1,
       cron = coalesce(excluded.cron, ${HERA_JOBS_TABLE}.cron)`,
    name,
    dueAt,
    cron
  )
}

export function insertJobIfAbsent(sql: SqlStorage, name: string, dueAt: number, cron: string | null): void {
  rows(
    sql,
    `INSERT INTO ${HERA_JOBS_TABLE} (name, due_at, gen, cron) VALUES (?, ?, 1, ?) ON CONFLICT(name) DO NOTHING`,
    name,
    dueAt,
    cron
  )
}

export function deleteJob(sql: SqlStorage, name: string): void {
  rows(sql, `DELETE FROM ${HERA_JOBS_TABLE} WHERE name = ?`, name)
}

/** Leases a due job: due again at `leaseUntil`, so a failed or interrupted run comes back after it. */
export function leaseJob(sql: SqlStorage, name: string, leaseUntil: number): void {
  rows(sql, `UPDATE ${HERA_JOBS_TABLE} SET due_at = ?, gen = ? WHERE name = ?`, leaseUntil, LEASED_GENERATION, name)
}

export function setJobDueAt(sql: SqlStorage, name: string, dueAt: number): void {
  rows(sql, `UPDATE ${HERA_JOBS_TABLE} SET due_at = ? WHERE name = ?`, dueAt, name)
}

export function lowerJobDueAt(sql: SqlStorage, name: string, dueAt: number): void {
  rows(sql, `UPDATE ${HERA_JOBS_TABLE} SET due_at = min(due_at, ?) WHERE name = ?`, dueAt, name)
}
