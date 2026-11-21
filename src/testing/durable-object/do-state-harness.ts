import type * as Duration from "effect/Duration";
import type { OrgId } from "../../core/schema/index.js";
import type {
  HeraOutboxRecord,
  TenantDurableObject,
} from "../../server/durable-object/index.js";
import { DEFAULT_TEST_TIME_MS, SAMPLE_IDS } from "../fixtures/sample-ids.js";
import {
  type ActiveClockSubscriber,
  durationToMillis,
  registerClockSubscriber,
  setSharedFallbackClockMs,
} from "../runner/clock-state.js";
import {
  createSqlStorageAdapter,
  getDatabaseSyncCtor,
  type NodeSqliteDatabase,
  normalizeSeedSqlStatements,
  readOutboxFromSqliteDb,
} from "./sqlite-storage.js";

export interface MakeTestDurableObjectStateOptions {
  /**
   * Value for `ctx.id.name`. Defaults to `SAMPLE_IDS.orgId`.
   * Pass `null` or `""` to simulate an anonymous or missing `ctx.id.name`.
   */
  readonly idName?: string | null | undefined;
  /**
   * Alias for `idName` when seeding a tenant Durable Object by `OrgId`.
   */
  readonly orgId?: OrgId | string | undefined;
  /**
   * Optional existing SQLite `DatabaseSync` instance to reuse across DO re-instantiations
   * (simulating Durable Object hibernation/wake cycles over persistent SQLite storage).
   */
  readonly sqliteDb?: NodeSqliteDatabase | undefined;
  /**
   * Optional SQL DDL/DML statements to execute against the in-memory SQLite database.
   * Statements referencing tables created by `TenantDurableObject` migrations are
   * automatically deferred until after migrations run.
   */
  readonly seedSql?: string | ReadonlyArray<string> | undefined;
  /**
   * Initial deterministic clock timestamp in milliseconds (defaults to `DEFAULT_TEST_TIME_MS`).
   */
  readonly initialTimeMs?: number | undefined;
  /**
   * Optional custom `setAlarm` interceptor (e.g. to simulate storage alarm failures).
   */
  readonly onSetAlarm?:
    | ((scheduledTime: number) => Promise<void> | void)
    | undefined;
}

export interface TestDurableObjectHarness {
  readonly state: DurableObjectState;
  readonly sqliteDb: NodeSqliteDatabase;
  readonly getScheduledAlarm: () => number | null;
  readonly setAlarmCalls: ReadonlyArray<number>;
  /** Every `state.abort(reason)` call, in order (`purgeStorage` resets the object with one). */
  readonly abortCalls: ReadonlyArray<string | undefined>;
  readonly transactionCount: () => number;
  readonly rollbackCount: () => number;
  readonly nowMs: () => number;
  readonly advanceClock: (duration: Duration.Input) => number;
  readonly setClock: (timestampMs: number) => number;
  readonly inspectOutbox: () => ReadonlyArray<HeraOutboxRecord>;
}

export interface InternalAnnotatedDoState extends DurableObjectState {
  __heraTestNow?: (() => number) | undefined;
  __heraPendingSeedSql?: ReadonlyArray<string> | undefined;
  __heraSqliteDb?: NodeSqliteDatabase | undefined;
  __heraDoInstance?:
    | TenantDurableObject<Record<string, unknown>>
    | undefined;
  __heraHarness?: TestDurableObjectHarness | undefined;
}

let lastActiveDoHarness: unknown;

export function getLastActiveDoHarness(): unknown {
  return lastActiveDoHarness;
}

export function setLastActiveDoHarness(harness: unknown): void {
  lastActiveDoHarness = harness;
}

/**
 * Creates a real SQLite-backed (`node:sqlite` `DatabaseSync(":memory:")`) `DurableObjectState`
 * test harness supporting `storage.sql.exec`, nested `storage.transactionSync` via SQLite `SAVEPOINT`,
 * `storage.getAlarm`/`setAlarm`/`deleteAll`, `blockConcurrencyWhile`, deterministic clock control, and `seedSql`.
 */
export function makeTestDurableObjectState(
  options?: MakeTestDurableObjectStateOptions,
): TestDurableObjectHarness {
  const DatabaseSync = getDatabaseSyncCtor();
  const db = options?.sqliteDb ?? new DatabaseSync(":memory:");
  let scheduledAlarm: number | null = null;
  const setAlarmCalls: Array<number> = [];
  const abortCalls: Array<string | undefined> = [];
  let txDepth = 0;
  let txCounter = 0;
  let rbCounter = 0;
  let currentClockMs = options?.initialTimeMs ?? DEFAULT_TEST_TIME_MS;
  setSharedFallbackClockMs(currentClockMs);

  const clockSubscriber: ActiveClockSubscriber = {
    getTimeMs: () => currentClockMs,
    setTimeMs: (timestampMs: number) => {
      currentClockMs = Math.round(timestampMs);
    },
  };
  registerClockSubscriber(clockSubscriber);

  const sqlStorage = createSqlStorageAdapter(db);

  const storage = {
    sql: sqlStorage,
    transactionSync<T>(closure: () => T): T {
      txCounter += 1;
      txDepth += 1;
      const savepoint = `hera_sp_${txDepth}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = closure();
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (err) {
        rbCounter += 1;
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw err;
      } finally {
        txDepth -= 1;
      }
    },
    async getAlarm(): Promise<number | null> {
      return scheduledAlarm;
    },
    async setAlarm(scheduledTime: number | Date): Promise<void> {
      const ms =
        scheduledTime instanceof Date
          ? scheduledTime.getTime()
          : Number(scheduledTime);
      if (!(ms > 0)) {
        // workerd parity: the platform refuses a non-positive alarm time.
        throw new TypeError("setAlarm() cannot be called with an alarm time <= 0");
      }
      if (options?.onSetAlarm !== undefined) {
        await options.onSetAlarm(ms);
      }
      scheduledAlarm = ms;
      setAlarmCalls.push(ms);
    },
    async deleteAlarm(): Promise<void> {
      scheduledAlarm = null;
    },
    async deleteAll(): Promise<void> {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      for (const { name } of tables) {
        db.exec(`DROP TABLE IF EXISTS "${name}"`);
      }
      scheduledAlarm = null;
    },
  } as unknown as DurableObjectStorage;

  const resolvedName =
    options !== undefined && "idName" in options
      ? (options.idName ?? undefined)
      : (options?.orgId ?? SAMPLE_IDS.orgId);

  const id: DurableObjectId = {
    ...(resolvedName !== undefined ? { name: resolvedName } : {}),
    toString: () => resolvedName ?? "anon_do_id",
    equals: (other: DurableObjectId) =>
      other.toString() === (resolvedName ?? "anon_do_id"),
  };

  const seedStatements = normalizeSeedSqlStatements(options?.seedSql);
  let deferredSeedStatements: ReadonlyArray<string> | undefined;
  if (seedStatements.length > 0) {
    const remaining: Array<string> = [];
    for (let i = 0; i < seedStatements.length; i += 1) {
      const stmt = seedStatements[i]!;
      try {
        db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no such table/i.test(msg)) {
          remaining.push(...seedStatements.slice(i));
          break;
        }
        throw err;
      }
    }
    if (remaining.length > 0) {
      deferredSeedStatements = remaining;
    }
  }

  const state: InternalAnnotatedDoState = {
    id,
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
    waitUntil(_promise: Promise<unknown>): void {},
    abort(reason?: string): void {
      abortCalls.push(reason);
    },
    __heraTestNow: () => currentClockMs,
    __heraPendingSeedSql: deferredSeedStatements,
    __heraSqliteDb: db,
  } as unknown as InternalAnnotatedDoState;

  const harness: TestDurableObjectHarness = {
    state,
    sqliteDb: db,
    getScheduledAlarm: () => scheduledAlarm,
    setAlarmCalls,
    abortCalls,
    transactionCount: () => txCounter,
    rollbackCount: () => rbCounter,
    nowMs: () => currentClockMs,
    advanceClock: (duration: Duration.Input) => {
      const delta = durationToMillis(duration);
      currentClockMs = Math.round(currentClockMs + delta);
      setSharedFallbackClockMs(currentClockMs);
      return currentClockMs;
    },
    setClock: (timestampMs: number) => {
      currentClockMs = Math.round(timestampMs);
      setSharedFallbackClockMs(currentClockMs);
      return currentClockMs;
    },
    inspectOutbox: () => readOutboxFromSqliteDb(db),
  };

  state.__heraHarness = harness;
  setLastActiveDoHarness(harness);

  return harness;
}
