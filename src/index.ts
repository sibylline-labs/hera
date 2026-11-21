import { HeraConfig } from "./core/config/index.js";
import { fn } from "./core/fn/index.js";
import { HeraSchema } from "./core/schema/index.js";
import {
  KeyedDurableObject,
  SyncTx,
  TenantDurableObject,
  getTenantRunStub,
  getTenantStub,
  orgDoName,
  orgRunDoName,
  parseOrgDoName,
  parseOrgRunDoName,
} from "./server/durable-object/index.js";
import {
  authedRoute,
  prefixRouter,
  publicRoute,
  router,
  tenantRoute,
} from "./server/routes/index.js";
import { queueConsumer } from "./server/queue/index.js";
import { rpcClient, rpcMethod } from "./server/rpc/index.js";
import { worker } from "./server/worker/index.js";

export * from "./core/index.js";
export * from "./server/index.js";

/**
 * Primary runtime namespace for `@sibylline-labs/hera` (Core + Server plane).
 * Local CLI runtime helpers live exclusively under `@sibylline-labs/hera/cli`.
 */
export const Hera = {
  fn,
  decode: HeraSchema.decode,
  secret: HeraConfig.secret,
  hexKey: HeraConfig.hexKey,
  keyring: HeraConfig.keyring,
  publicRoute,
  authedRoute,
  tenantRoute,
  router,
  prefixRouter,
  rpcMethod,
  rpcClient,
  queueConsumer,
  worker,
  TenantDurableObject,
  KeyedDurableObject,
  getTenantStub,
  orgDoName,
  parseOrgDoName,
  getTenantRunStub,
  orgRunDoName,
  parseOrgRunDoName,
  SyncTx,
} as const;
