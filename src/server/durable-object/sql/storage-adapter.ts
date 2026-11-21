import * as Cause from "effect/Cause"
import type * as Schema from "effect/Schema"
import {
  REDACTED_VALUE,
  scrubLogString,
} from "../../../core/logger/index.js"
import { HeraSchema } from "../../../core/schema/index.js"
import { HeraSqlError, type HeraSqlExecResult } from "../types.js"

const INLINE_SECRET_TOKEN_PATTERN =
  /(?:ol|sib|sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]+/i

export function summarizeRedactedReason(
  error: unknown,
  fallback = "SQLite operation failed"
): string {
  const rawMessage =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : ""
  if (rawMessage.length > 0) {
    if (INLINE_SECRET_TOKEN_PATTERN.test(rawMessage)) {
      return REDACTED_VALUE
    }
    return scrubLogString(rawMessage)
  }
  return fallback
}

/** Whether `name` is a table. A probe of `sqlite_master` only: it never creates storage. */
export function hasSqlTable(sqlStorage: SqlStorage, name: string): boolean {
  return (
    sqlStorage
      .exec("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", name)
      .toArray().length > 0
  )
}

export function isAsyncFiberCause(cause: Cause.Cause<unknown>): boolean {
  const squashed = Cause.squash(cause)
  if (squashed instanceof Error) {
    return (
      squashed.name === "AsyncFiberException" ||
      squashed.name === "AsyncFiberError" ||
      squashed.message.includes("asynchronous Effect") ||
      squashed.message.includes("Effect.runSync")
    )
  }
  return String(squashed).includes("asynchronous Effect")
}

export function executeSqlCursor(
  sqlStorage: SqlStorage,
  sql: string,
  params?: ReadonlyArray<unknown>
): HeraSqlExecResult {
  const cursor = sqlStorage.exec(sql, ...(params ?? []))
  const rawRows = cursor.toArray() as ReadonlyArray<Record<string, unknown>>
  const rows = rawRows.map((row) => ({ ...row }))
  return {
    rowsRead: cursor.rowsRead ?? rows.length,
    rowsWritten: cursor.rowsWritten ?? 0,
    rows,
  }
}

export function querySqlCursor<Row = Record<string, unknown>>(
  sqlStorage: SqlStorage,
  sql: string,
  params?: ReadonlyArray<unknown>,
  rowSchema?: Schema.Top
): ReadonlyArray<Row> {
  const cursor = sqlStorage.exec(sql, ...(params ?? []))
  const rawRows = cursor.toArray() as ReadonlyArray<Record<string, unknown>>
  const normalizedRows = rawRows.map((row) => ({ ...row }))
  if (rowSchema === undefined) {
    return normalizedRows as unknown as ReadonlyArray<Row>
  }
  const decodeRow = HeraSchema.decodeUnknownSync(
    rowSchema as unknown as Schema.Schema<Row>
  )
  return normalizedRows.map((row) => decodeRow(row))
}

export function wrapSqlError(
  operation: string,
  fallback: string,
  fixedReason?: string
): (err: unknown) => HeraSqlError {
  return (err: unknown) =>
    HeraSqlError.is(err)
      ? err
      : new HeraSqlError({
          operation,
          reason: fixedReason ?? summarizeRedactedReason(err, fallback),
        })
}
