export {
  getTenantStub,
  orgDoName,
  parseOrgDoName,
  resolveTenantDoOrgId,
} from "./naming.js"
export {
  getTenantRunStub,
  isRunKey,
  type OrgRun,
  orgRunDoName,
  parseOrgRunDoName,
} from "./run-naming.js"
import { queueSink } from "./outbox/queue-sink.js"
import { seedSequenceSql } from "./outbox/sequence.js"
import { planQueueSends, QUEUE_LIMITS, utf8Bytes } from "./outbox/send-chunks.js"

export { computeOutboxBackoffMs } from "./outbox/schema.js"
export {
  type HeraOutboxEncodedMessage,
  type HeraOutboxQueueSinkOptions,
  type HeraOutboxRejection,
} from "./outbox/queue-sink.js"
export { type HeraOutboxQueueLimits, type QueueSendPlan } from "./outbox/send-chunks.js"
export { SyncTx } from "./sql/sync-tx.js"
export { hasSqlTable } from "./sql/storage-adapter.js"
export { hasSqlTableTx } from "./sql/table-probe.js"
export { type HeraDoorWithin, runDoor, runDoorSync } from "./door.js"
export * from "./state-machine/index.js"
export { HeraDurableObjectBase, type HeraDurableObjectIdentity } from "./base-do.js"
export { type AlarmDriver, StorageAlarmDriver } from "./alarm-driver.js"
export { type BeforePurgeResult } from "./purge.js"
export {
  HeraJobError,
  type HeraJobHandler,
  type HeraJobNames,
  type HeraJobRegistry,
  type HeraJobScheduler,
  type HeraJobWhen,
} from "./jobs/types.js"
export {
  DurableObjectKeyError,
  type HeraKeyedDurableObjectOptions,
  KeyedDurableObject,
  requireDurableObjectName,
} from "./keyed-do.js"
export { TenantDurableObject } from "./tenant-do.js"
export {
  type HeraAppliedMigration,
  type HeraDoJurisdiction,
  type HeraGetTenantRunStubOptions,
  type HeraGetTenantStubOptions,
  type HeraKeyedSqlClient,
  type HeraKeyedSyncTx,
  type HeraLegacyMigrationLedger,
  type HeraMigration,
  HeraMigrationError,
  type HeraOutboxBackoffOptions,
  type HeraOutboxDeadLetter,
  type HeraOutboxDeliveryReport,
  type HeraOutboxDrainResult,
  type HeraOutboxFailure,
  type HeraOutboxOrdering,
  type HeraEnqueueOutbox,
  type HeraOrderedOutboxEventInput,
  type HeraOrderedOutboxRecord,
  type HeraOutboxEventInput,
  type HeraOutboxRecord,
  type HeraSqlClient,
  HeraSqlError,
  type HeraSqlExecResult,
  type HeraSyncTx,
  type HeraTenantDurableObjectOptions,
  type OrgDurableObjectName,
  type OrgRunDurableObjectName,
  type OutboxDeliveryContext,
  type OutboxDeliverySink,
  type OutboxQueueBinding,
  type OutboxQueueContentType,
  type SyncEffect,
  SyncEffectTypeId,
  SyncTxAsyncViolationError,
  type SyncTxInput,
  type SyncYieldable,
  TenantIdentityError,
} from "./types.js"

/**
 * Outbox delivery helpers: `queueSink` is a `deliverOutboxBatch` that sends to a
 * Cloudflare Queue inside its limits and rejects an oversize record without blocking the rest;
 * `seedSequenceSql` raises the ordered-enqueue sequence to a counter a migration or restore carries over.
 */
export const HeraOutbox = {
  queueSink,
  seedSequenceSql,
  planQueueSends,
  utf8Bytes,
  QUEUE_LIMITS,
} as const
