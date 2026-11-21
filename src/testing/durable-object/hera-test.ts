import { HeraTest as HeraTestCore } from "../hera-test.js";
import {
  inspectOutbox,
  makeTestTenantDoHarness,
  triggerAlarm,
} from "./do-harness.js";
import { makeTestDurableObjectState } from "./do-state-harness.js";
import { makeTestLayer } from "./test-layer.js";

/**
 * `@sibylline-labs/hera/testing/durable-object` namespace: the `/testing` `HeraTest` plus the
 * in-memory SQLite DO harness, with `layer` backing `HeraTenantCtx.db` by that harness.
 */
export const HeraTest = {
  ...HeraTestCore,
  layer: makeTestLayer,
  makeTestLayer,
  inspectOutbox,
  triggerAlarm,
  tenantDoHarness: makeTestTenantDoHarness,
  makeTestTenantDoHarness,
  makeTestDurableObjectState,
} as const;
