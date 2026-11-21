/**
 * One row per model request, from Gemini's `usageMetadata`, keyed by the AI Gateway's
 * `cf-aig-log-id` (the Gemini `responseId` when no gateway header is present). Keying makes the
 * write idempotent: a request whose key is already metered (a replayed response) writes nothing.
 */
export interface HeraAgentMeterRow {
  readonly logId: string
  readonly atMs: number
  readonly model: string
  readonly inputTokens: number
  readonly candidatesTokens: number
  readonly thoughtsTokens: number
  readonly cachedTokens: number
  readonly totalTokens: number
  /** The operation that issued the request; `undefined` for a row written before the column existed or outside a `Hera.agent` host. */
  readonly operationId?: string | undefined
}

export interface HeraAgentMeter {
  /** Writes `row` unless its `logId` is already metered; a no-op once closed. */
  readonly record: (row: HeraAgentMeterRow) => void
  readonly rows: () => ReadonlyArray<HeraAgentMeterRow>
  /** Stops writing: a stream that settles after a purge must not recreate the table (A4). */
  readonly close: () => void
}

/** The slice of `DurableObjectStorage["sql"]` the meter uses. */
export interface MeterSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> }
}

export const HERA_AGENT_METER_TABLE = "_hera_agent_meter"

const CREATE = `CREATE TABLE IF NOT EXISTS ${HERA_AGENT_METER_TABLE} (
  log_id TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  candidates_tokens INTEGER NOT NULL,
  thoughts_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  operation_id TEXT
)`

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0))

const hasOperationColumn = (sql: MeterSql): boolean =>
  sql.exec(`PRAGMA table_info(${HERA_AGENT_METER_TABLE})`).toArray().some((c) => c.name === "operation_id")

/** A meter over the object's SQLite. The table is created, or gains `operation_id`, on the first write. */
function sqlite(sql: MeterSql): HeraAgentMeter {
  let created = false
  let closed = false
  const exists = () =>
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", HERA_AGENT_METER_TABLE).toArray().length > 0
  return {
    record(row) {
      if (closed) return
      if (!created) {
        sql.exec(CREATE)
        if (!hasOperationColumn(sql)) sql.exec(`ALTER TABLE ${HERA_AGENT_METER_TABLE} ADD COLUMN operation_id TEXT`)
        created = true
      }
      sql.exec(
        `INSERT OR IGNORE INTO ${HERA_AGENT_METER_TABLE}
           (log_id, at_ms, model, input_tokens, candidates_tokens, thoughts_tokens, cached_tokens, total_tokens, operation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.logId,
        row.atMs,
        row.model,
        row.inputTokens,
        row.candidatesTokens,
        row.thoughtsTokens,
        row.cachedTokens,
        row.totalTokens,
        row.operationId ?? null
      )
    },
    rows() {
      if (!exists()) return []
      return sql
        .exec(`SELECT * FROM ${HERA_AGENT_METER_TABLE} ORDER BY at_ms, log_id`)
        .toArray()
        .map((r) => ({
          logId: String(r.log_id),
          atMs: num(r.at_ms),
          model: String(r.model),
          inputTokens: num(r.input_tokens),
          candidatesTokens: num(r.candidates_tokens),
          thoughtsTokens: num(r.thoughts_tokens),
          cachedTokens: num(r.cached_tokens),
          totalTokens: num(r.total_tokens),
          operationId: typeof r.operation_id === "string" ? r.operation_id : undefined,
        }))
    },
    close() {
      closed = true
    },
  }
}

/** An in-memory meter, for a host with no SQLite (and for tests). */
function memory(): HeraAgentMeter {
  const byId = new Map<string, HeraAgentMeterRow>()
  let closed = false
  return {
    record(row) {
      if (!closed && !byId.has(row.logId)) byId.set(row.logId, row)
    },
    rows: () => [...byId.values()],
    close() {
      closed = true
    },
  }
}

export const HeraAgentMeter = { sqlite, memory } as const
