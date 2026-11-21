import { createRequire } from "node:module";
import type { OrgId } from "../../core/schema/index.js";
import type { HeraOutboxRecord } from "../../server/durable-object/index.js";

export interface NodeSqliteStatement {
  all(
    ...params: ReadonlyArray<unknown>
  ): ReadonlyArray<Record<string, unknown>>;
  get(...params: ReadonlyArray<unknown>): Record<string, unknown> | undefined;
}

export interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

let cachedDatabaseSyncCtor: (new (path: string) => NodeSqliteDatabase) | undefined;

export function getDatabaseSyncCtor(): new (path: string) => NodeSqliteDatabase {
  if (cachedDatabaseSyncCtor === undefined) {
    const req = createRequire(import.meta.url);
    const mod = req("node:sqlite") as {
      DatabaseSync: new (path: string) => NodeSqliteDatabase;
    };
    cachedDatabaseSyncCtor = mod.DatabaseSync;
  }
  return cachedDatabaseSyncCtor;
}

export function normalizeSeedSqlStatements(
  seedSql: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (seedSql === undefined) {
    return [];
  }
  const rawList = typeof seedSql === "string" ? [seedSql] : seedSql;
  const statements: Array<string> = [];
  for (const chunk of rawList) {
    for (const part of chunk.split(";")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
    }
  }
  return statements;
}

export function coerceOutboxRow(row: Record<string, unknown>): HeraOutboxRecord {
  return {
    id: String(row.id),
    orgId: row.org_id as OrgId,
    type: String(row.event_type),
    eventType: String(row.event_type),
    payload: JSON.parse(String(row.payload_json)),
    payloadJson: String(row.payload_json),
    requestId: row.request_id === null ? null : String(row.request_id),
    ...(typeof row.traceparent === "string" ? { traceparent: row.traceparent } : {}),
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: Number(row.created_at),
  };
}

export function readOutboxFromSqliteDb(
  sqliteDb: NodeSqliteDatabase,
): ReadonlyArray<HeraOutboxRecord> {
  const tableCheck = sqliteDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_hera_outbox'",
    )
    .get();
  if (!tableCheck) {
    return [];
  }
  const rows = sqliteDb
    .prepare(
      `SELECT id, org_id, event_type, payload_json, request_id, traceparent, attempts, next_attempt_at, last_error, created_at
       FROM _hera_outbox
       ORDER BY created_at ASC, id ASC`,
    )
    .all();

  return rows.map((row) => coerceOutboxRow(row));
}

export function createSqlStorageAdapter(db: NodeSqliteDatabase): SqlStorage {
  return {
    exec(query: string, ...bindings: ReadonlyArray<unknown>) {
      const stmt = db.prepare(query);
      const rawRows = stmt.all(...bindings);
      const rows = rawRows.map((row) => ({ ...row }));
      const changesRow = db.prepare("SELECT changes() AS c").get();
      const rowsWritten = Number(changesRow?.c ?? 0);
      const columnNames = rows.length > 0 ? Object.keys(rows[0]!) : [];
      return {
        columnNames,
        rowsRead: rows.length,
        rowsWritten,
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) {
            throw new Error(`Expected exactly 1 row, got ${rows.length}`);
          }
          return rows[0]!;
        },
        raw: () => rows.map((r) => columnNames.map((col) => r[col])),
        [Symbol.iterator]: function* () {
          yield* rows;
        },
      };
    },
  } as unknown as SqlStorage;
}
