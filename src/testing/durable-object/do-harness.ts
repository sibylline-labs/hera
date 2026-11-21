import type * as Duration from "effect/Duration";
import type { OrgId } from "../../core/schema/index.js";
import {
  HeraDurableObjectBase,
  type HeraOutboxRecord,
  type HeraTenantDurableObjectOptions,
  TenantDurableObject,
} from "../../server/durable-object/index.js";
import { SAMPLE_IDS } from "../fixtures/sample-ids.js";
import {
  broadcastClockAdvance,
  broadcastClockSet,
  durationToMillis,
} from "../runner/clock-state.js";
import {
  getLastActiveDoHarness,
  type InternalAnnotatedDoState,
  makeTestDurableObjectState,
  setLastActiveDoHarness,
  type TestDurableObjectHarness,
} from "./do-state-harness.js";
import {
  coerceOutboxRow,
  type NodeSqliteDatabase,
  readOutboxFromSqliteDb,
} from "./sqlite-storage.js";

export type OutboxInspectionTarget =
  | HeraDurableObjectBase<any, any>
  | TestDurableObjectHarness
  | TestTenantDoHarness<any>
  | DurableObjectState
  | undefined;

/**
 * Inspects pending `_hera_outbox` records from a `TenantDurableObject`, `TestDurableObjectHarness`,
 * `TestTenantDoHarness`, or `DurableObjectState` (defaults to the most recently created test harness).
 */
export function inspectOutbox(
  target?: OutboxInspectionTarget,
): ReadonlyArray<HeraOutboxRecord> {
  const effective = (target ?? getLastActiveDoHarness()) as OutboxInspectionTarget;
  if (effective === undefined) {
    return [];
  }
  if (effective instanceof HeraDurableObjectBase) {
    return effective.getPendingOutboxRecords() as ReadonlyArray<HeraOutboxRecord>;
  }
  if (
    typeof effective === "object" &&
    effective !== null &&
    "instance" in effective &&
    effective.instance instanceof HeraDurableObjectBase
  ) {
    return effective.instance.getPendingOutboxRecords() as ReadonlyArray<HeraOutboxRecord>;
  }
  if (
    typeof effective === "object" &&
    effective !== null &&
    "sqliteDb" in effective &&
    effective.sqliteDb !== undefined
  ) {
    return readOutboxFromSqliteDb(
      (effective as TestDurableObjectHarness).sqliteDb,
    );
  }
  const annotatedState = effective as InternalAnnotatedDoState;
  if (annotatedState.__heraDoInstance !== undefined) {
    return annotatedState.__heraDoInstance.getPendingOutboxRecords();
  }
  if (annotatedState.__heraSqliteDb !== undefined) {
    return readOutboxFromSqliteDb(annotatedState.__heraSqliteDb);
  }
  if (
    typeof (effective as DurableObjectState).storage?.sql?.exec === "function"
  ) {
    try {
      const rows = (effective as DurableObjectState).storage.sql
        .exec(
          `SELECT id, org_id, event_type, payload_json, request_id, traceparent, attempts, next_attempt_at, last_error, created_at
           FROM _hera_outbox
           ORDER BY created_at ASC, id ASC`,
        )
        .toArray() as Array<Record<string, unknown>>;
      return rows.map((row) => coerceOutboxRow(row));
    } catch {
      return [];
    }
  }
  return [];
}

export interface TriggerAlarmResult {
  readonly outbox: ReadonlyArray<HeraOutboxRecord>;
  readonly nextAlarmAt: number | null;
  readonly domainAlarmAt: number | null;
  readonly scheduledAlarm: number | null;
}

function resolveDoInstanceFromTarget(
  target?: OutboxInspectionTarget,
): HeraDurableObjectBase<Record<string, unknown>, string> {
  const effective = (target ?? getLastActiveDoHarness()) as OutboxInspectionTarget;
  if (effective instanceof HeraDurableObjectBase) {
    return effective;
  }
  if (
    typeof effective === "object" &&
    effective !== null &&
    "instance" in effective &&
    effective.instance instanceof HeraDurableObjectBase
  ) {
    return effective.instance;
  }
  if (
    typeof effective === "object" &&
    effective !== null &&
    "state" in effective
  ) {
    const annotated = (effective as { readonly state: InternalAnnotatedDoState })
      .state;
    if (annotated.__heraDoInstance !== undefined) {
      return annotated.__heraDoInstance;
    }
  }
  const annotatedState = effective as InternalAnnotatedDoState | undefined;
  if (annotatedState?.__heraDoInstance !== undefined) {
    return annotatedState.__heraDoInstance;
  }
  throw new Error(
    "HeraTest.triggerAlarm requires a Hera Durable Object instance or a harness attached to one",
  );
}

/**
 * Triggers `alarm()` on a `TenantDurableObject` or `KeyedDurableObject` (or test harness), optionally advancing or setting
 * the deterministic test clock before firing, and returns updated outbox and alarm state.
 */
export async function triggerAlarm(
  target?: OutboxInspectionTarget,
  advanceOrTimestamp?: Duration.Input,
): Promise<TriggerAlarmResult> {
  const doInstance = resolveDoInstanceFromTarget(target);
  const annotatedState = doInstance.ctx as InternalAnnotatedDoState;
  const harness = annotatedState.__heraHarness;

  if (advanceOrTimestamp !== undefined) {
    if (
      typeof advanceOrTimestamp === "number" &&
      advanceOrTimestamp >= 100_000_000_000
    ) {
      if (harness) {
        harness.setClock(advanceOrTimestamp);
      } else {
        broadcastClockSet(advanceOrTimestamp);
      }
    } else {
      if (harness) {
        harness.advanceClock(advanceOrTimestamp);
      } else {
        broadcastClockAdvance(durationToMillis(advanceOrTimestamp));
      }
    }
  }

  await doInstance.alarm();

  const scheduledAlarm = await doInstance.ctx.storage.getAlarm();
  return {
    outbox: doInstance.getPendingOutboxRecords() as ReadonlyArray<HeraOutboxRecord>,
    nextAlarmAt: doInstance.getNextCompositeAlarmAt(),
    domainAlarmAt: doInstance.getDomainAlarmAt(),
    scheduledAlarm,
  };
}

export interface TestTenantDoHarnessOptions<Env = Record<string, unknown>>
  extends HeraTenantDurableObjectOptions {
  readonly orgId?: OrgId | string | null | undefined;
  readonly env?: Env | undefined;
  readonly seedSql?: string | ReadonlyArray<string> | undefined;
  readonly initialTimeMs?: number | undefined;
  readonly sqliteDb?: NodeSqliteDatabase | undefined;
  readonly onSetAlarm?:
    | ((scheduledTime: number) => Promise<void> | void)
    | undefined;
}

export interface TestTenantDoHarness<
  Do extends TenantDurableObject<any> = TenantDurableObject<
    Record<string, unknown>
  >,
> {
  readonly instance: Do;
  readonly do: Do;
  readonly state: DurableObjectState;
  readonly sqliteDb: NodeSqliteDatabase;
  readonly harness: TestDurableObjectHarness;
  readonly orgId: OrgId;
  readonly nowMs: () => number;
  readonly advanceClock: (duration: Duration.Input) => number;
  readonly setClock: (timestampMs: number) => number;
  readonly inspectOutbox: () => ReadonlyArray<HeraOutboxRecord>;
  readonly triggerAlarm: (
    advanceOrTimestamp?: Duration.Input,
  ) => Promise<TriggerAlarmResult>;
}

/**
 * Instantiates a `TenantDurableObject` subclass against an in-memory SQLite database
 * with `seedSql`, deterministic clock control, and outbox/alarm inspection helpers.
 */
export function makeTestTenantDoHarness<
  Env = Record<string, unknown>,
  Do extends TenantDurableObject<Env> = TenantDurableObject<Env>,
>(
  DoClass: new (
    ctx: DurableObjectState,
    env: Env,
    options?: HeraTenantDurableObjectOptions,
  ) => Do,
  options?: TestTenantDoHarnessOptions<Env>,
): TestTenantDoHarness<Do> {
  const stateHarness = makeTestDurableObjectState({
    idName:
      options !== undefined && "orgId" in options
        ? options.orgId
        : SAMPLE_IDS.orgId,
    seedSql: options?.seedSql,
    initialTimeMs: options?.initialTimeMs,
    sqliteDb: options?.sqliteDb,
    onSetAlarm: options?.onSetAlarm,
  });

  const env = (options?.env ?? {}) as Env;
  const instance = new DoClass(stateHarness.state, env, options);
  (stateHarness.state as InternalAnnotatedDoState).__heraDoInstance =
    instance as unknown as TenantDurableObject<Record<string, unknown>>;

  const result: TestTenantDoHarness<Do> = {
    instance,
    do: instance,
    state: stateHarness.state,
    sqliteDb: stateHarness.sqliteDb,
    harness: stateHarness,
    orgId: instance.orgId,
    nowMs: () => stateHarness.nowMs(),
    advanceClock: (duration: Duration.Input) =>
      stateHarness.advanceClock(duration),
    setClock: (timestampMs: number) => stateHarness.setClock(timestampMs),
    inspectOutbox: () => instance.getPendingOutboxRecords(),
    triggerAlarm: (advanceOrTimestamp?: Duration.Input) =>
      triggerAlarm(instance, advanceOrTimestamp),
  };

  setLastActiveDoHarness(result);
  return result;
}
