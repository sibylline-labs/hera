import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import {
  type HeraMigration,
  type HeraOutboxRecord,
  type HeraSqlClient,
  TenantDurableObject,
} from "../../server/durable-object/index.js";
import {
  composeTestLayer,
  type HeraTestLayerBaseOptions,
  type HeraTestLayerContext,
  resolveTestLayerIds,
} from "../context/compose-test-layer.js";
import { makeTestTenantDoHarness } from "./do-harness.js";

class DefaultTestTenantDO extends TenantDurableObject.configure({
  service: "hera-test",
  migrations: [],
}) {}

export interface HeraTestDoLayerOptions extends HeraTestLayerBaseOptions {
  readonly seedSql?: string | ReadonlyArray<string> | undefined;
  readonly migrations?: ReadonlyArray<HeraMigration> | undefined;
  readonly deliverOutboxBatch?:
    | ((
        records: ReadonlyArray<HeraOutboxRecord>,
      ) => Effect.Effect<void, unknown, never> | Promise<void> | void)
    | undefined;
}

/**
 * The `/testing` layer with `HeraTenantCtx.db` backed by an in-memory SQLite tenant Durable
 * Object (`migrations` and `seedSql` pre-applied) whose clock follows the `TestClock`.
 */
export function makeTestLayer(
  options?: HeraTestDoLayerOptions,
): Layer.Layer<HeraTestLayerContext> {
  const { orgId, service, initialTimeMs } = resolveTestLayerIds(options);
  const doHarness = makeTestTenantDoHarness(DefaultTestTenantDO, {
    orgId,
    service,
    migrations: options?.migrations ?? [],
    seedSql: options?.seedSql,
    initialTimeMs,
    deliverOutboxBatch: options?.deliverOutboxBatch,
    env: (options?.env as Record<string, unknown> | undefined) ?? {},
    sink: options?.sink,
  });

  return composeTestLayer(options, {
    db: doHarness.instance.db as HeraSqlClient,
    scheduleDomainAlarm: (atMs: number) =>
      doHarness.instance.scheduleDomainAlarm(atMs).pipe(Effect.orDie),
    setClock: (timeMs: number) => doHarness.setClock(timeMs),
  });
}
