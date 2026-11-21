import {
  makeTestCtx,
  makeTestCtxLayer,
  makeTestLayer,
  makeTestTenantCtx,
  makeTestTenantCtxLayer,
  withTestCtx,
  withTestEnv,
  withTestTenantCtx,
} from "./context/index.js";
import {
  DEFAULT_TEST_TIME_MS,
  makeTestHexKey,
  makeTestKeyring,
  SAMPLE_IDS,
} from "./fixtures/index.js";
import {
  makeTestRouteRequest,
  makeTestRpcDouble,
  parseProblemDetailsResponse,
} from "./http-rpc/index.js";
import { makeTestAuthority } from "./authority/index.js";
import { makeTestFlags } from "./flags/index.js";
import { makeTestObjectStore } from "./object-store/index.js";
import { makeTestTelemetry } from "./telemetry/index.js";
import {
  advanceClock,
  advanceClockSync,
  currentTimeMillis,
  runTest,
  runTestExit,
  setClock,
  setClockSync,
} from "./runner/index.js";

/**
 * Bundled `@sibylline-labs/hera/testing` namespace. Needs no ambient
 * types; the DO harness members live on `HeraTest` from `@sibylline-labs/hera/testing/durable-object`.
 */
export const HeraTest = {
  SAMPLE_IDS,
  DEFAULT_TEST_TIME_MS,
  layer: makeTestLayer,
  makeTestLayer,
  advanceClock,
  setClock,
  advanceClockSync,
  setClockSync,
  currentTimeMillis,
  runTest,
  runTestExit,
  rpcDouble: makeTestRpcDouble,
  makeTestRpcDouble,
  makeTestRouteRequest,
  parseProblemDetailsResponse,
  objectStore: makeTestObjectStore,
  makeTestObjectStore,
  flags: makeTestFlags,
  telemetry: makeTestTelemetry,
  makeTestTelemetry,
  makeTestFlags,
  authority: makeTestAuthority,
  makeTestAuthority,
  makeTestCtx,
  makeTestTenantCtx,
  makeTestCtxLayer,
  makeTestTenantCtxLayer,
  withTestCtx,
  withTestTenantCtx,
  withTestEnv,
  makeTestHexKey,
  makeTestKeyring,
} as const;
