import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type HeraTenantDb } from "../../core/context/index.js"
import {
  type AnyHeraDefinedError,
  HeraError,
  type HeraDefinedErrorInstance,
} from "../../core/errors/index.js"
import { type HeraLogger, type LogSink } from "../../core/logger/index.js"
import { type OrgId, type RequestId } from "../../core/schema/index.js"
import type {
  HeraOrderedOutboxEventInput,
  HeraOrderedOutboxRecord,
  HeraOutboxBackoffOptions,
  HeraOutboxEventInput,
  HeraOutboxOrdering,
  HeraOutboxRecord,
  OutboxDeliverySink,
} from "./outbox/types.js"

export type {
  HeraOutboxBackoffOptions,
  HeraOutboxDeadLetter,
  HeraOutboxDeliveryReport,
  HeraOutboxDrainResult,
  HeraOutboxEventInput,
  HeraOrderedOutboxEventInput,
  HeraOrderedOutboxRecord,
  HeraOutboxFailure,
  HeraOutboxOrdering,
  HeraOutboxRecord,
  OutboxDeliveryContext,
  OutboxDeliverySink,
  OutboxQueueBinding,
  OutboxQueueContentType,
} from "./outbox/types.js"

/** Canonical naming helper for per-org Durable Objects (`org:<OrgId>`). */
export type OrgDurableObjectName = `org:${string}`

/** Canonical name of one run's Durable Object (`org:<OrgId>:run:<runKey>`), built by `orgRunDoName`. */
export type OrgRunDurableObjectName = `org:${string}:run:${string}`

/**
 * Typed fail-closed error thrown when a `TenantDurableObject` is instantiated or accessed
 * without a valid `OrgId` in `this.ctx.id.name`, or when `Hera.getTenantStub` is given
 * an invalid `OrgId`.
 */
export const TenantIdentityError = HeraError.define("TenantIdentityError", {
  code: "invalid_subject",
  publicMessage:
    "Durable Object instance does not have a valid tenant OrgId identity",
  fields: { reason: Schema.String },
})
export type TenantIdentityError = InstanceType<typeof TenantIdentityError>

/** Typed error raised when a declarative SQLite migration fails or violates version ordering. */
export const HeraMigrationError = HeraError.define("HeraMigrationError", {
  code: "internal_error",
  publicMessage: "Durable Object SQLite migration failed",
  fields: {
    version: Schema.Number,
    migrationName: Schema.String,
    reason: Schema.String,
  },
})
export type HeraMigrationError = InstanceType<typeof HeraMigrationError>

/** Typed error raised when a `SyncTx` SQL query, statement, or row schema decode fails. */
export const HeraSqlError = HeraError.define("HeraSqlError", {
  code: "internal_error",
  publicMessage: "Durable Object SQLite operation failed",
  fields: { operation: Schema.String, reason: Schema.String },
})
export type HeraSqlError = InstanceType<typeof HeraSqlError>

/**
 * Typed error raised when an asynchronous Effect (`Effect.promise`, `Effect.sleep`) is forced
 * into `transactSync` or `transactWithOutbox` at runtime.
 */
export const SyncTxAsyncViolationError = HeraError.define(
  "SyncTxAsyncViolationError",
  {
    code: "internal_error",
    publicMessage:
      "Asynchronous Effect execution is forbidden inside a synchronous SQLite transaction",
    fields: { operation: Schema.String, reason: Schema.String },
  }
)
export type SyncTxAsyncViolationError = InstanceType<
  typeof SyncTxAsyncViolationError
>

/**
 * Declarative SQLite migration descriptor executed inside `this.ctx.blockConcurrencyWhile(...)`
 * on Durable Object instantiation.
 */
export interface HeraMigration {
  readonly version: number
  readonly name: string
  readonly sql: string | ReadonlyArray<string>
}

export interface HeraAppliedMigration {
  readonly version: number
  readonly name: string
  readonly appliedAt: number
}

/** Branded synchronous Effect type. */
export const SyncEffectTypeId: unique symbol = Symbol.for(
  "@sibylline/hera/SyncEffect"
)
export type SyncEffectTypeId = typeof SyncEffectTypeId

export interface SyncEffect<out A, out E = never, out R = never>
  extends Effect.Effect<A, E, R> {
  readonly [SyncEffectTypeId]: SyncEffectTypeId
  [Symbol.iterator](): Effect.EffectIterator<SyncEffect<A, E, R>>
}

export type SyncYieldable<A = any, E = any> =
  | SyncEffect<A, E, never>
  | Effect.Effect<never, AnyHeraDefinedError | HeraError, never>
  | HeraDefinedErrorInstance<string, any, any, any>

export type ExtractSyncYieldError<Eff> = [Eff] extends [never]
  ? never
  : Eff extends SyncEffect<infer _A, infer E, infer _R>
    ? E
    : Eff extends Effect.Effect<never, infer E, infer _R>
      ? E
      : Eff extends HeraDefinedErrorInstance<any, any, any, any>
        ? Eff
        : never

export interface HeraSqlExecResult {
  readonly rowsRead: number
  readonly rowsWritten: number
  readonly rows: ReadonlyArray<Record<string, unknown>>
}


export interface HeraSqlQueryFn {
  <Row = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ): SyncEffect<ReadonlyArray<Row>, HeraSqlError>
  <S extends Schema.Top>(
    sql: string,
    params: ReadonlyArray<unknown> | undefined,
    rowSchema: S
  ): SyncEffect<ReadonlyArray<Schema.Schema.Type<S>>, HeraSqlError>
}

export interface HeraTransactFn<Tx = HeraSyncTx> {
  <A, E = never>(
    effect: SyncEffect<A, E, never>
  ): SyncEffect<A, E | HeraSqlError | SyncTxAsyncViolationError>
  <A, E = never>(
    fn: (tx: Tx) => SyncEffect<A, E, never>
  ): SyncEffect<A, E | HeraSqlError | SyncTxAsyncViolationError>
  <Eff extends SyncYieldable<any, any>, AEff>(
    genFn: (tx: Tx) => Generator<Eff, AEff, never>
  ): SyncEffect<
    AEff,
    ExtractSyncYieldError<Eff> | HeraSqlError | SyncTxAsyncViolationError
  >
}

/** Stages one outbox record in the current transaction; `ordered: true` also takes the object's next sequence number. */
export interface HeraEnqueueOutbox<Owner extends string = string> {
  <Payload = unknown>(event: HeraOrderedOutboxEventInput<Payload>): SyncEffect<HeraOrderedOutboxRecord<Owner>, HeraSqlError>
  <Payload = unknown>(event: HeraOutboxEventInput<Payload>): SyncEffect<HeraOutboxRecord<Owner>, HeraSqlError>
}

/** Transaction handle of a `KeyedDurableObject`: a `HeraSyncTx` without `orgId`. */
export interface HeraKeyedSyncTx<Owner extends string = string> {
  readonly exec: (
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => SyncEffect<HeraSqlExecResult, HeraSqlError>
  readonly query: HeraSqlQueryFn
  readonly enqueueOutbox: HeraEnqueueOutbox<Owner>
  readonly succeed: <A>(value: A) => SyncEffect<A>
  readonly fail: <E>(error: E) => SyncEffect<never, E>
  readonly die: (defect: unknown) => SyncEffect<never>
  readonly sync: <A>(evaluate: () => A) => SyncEffect<A>
  readonly try: <A, E = HeraSqlError>(options: {
    readonly try: () => A
    readonly catch: (error: unknown) => E
  }) => SyncEffect<A, E>
  readonly gen: <Eff extends SyncYieldable<any, any>, AEff>(
    body: () => Generator<Eff, AEff, never>
  ) => SyncEffect<AEff, ExtractSyncYieldError<Eff>>
}

/** Transaction handle passed to `ctx.db.transactSync` and `ctx.db.transactWithOutbox` callbacks. */
export interface HeraSyncTx extends HeraKeyedSyncTx<OrgId> {
  readonly orgId: OrgId
}

export type SyncTxInput<A, E> =
  | SyncEffect<A, E, never>
  | ((tx: HeraSyncTx) => SyncEffect<A, E, never>)
  | (<Eff extends SyncYieldable<any, E>>(
      tx: HeraSyncTx
    ) => Generator<Eff, A, never>)

/** Synchronous SQLite client of a `KeyedDurableObject`: a `HeraSqlClient` without `orgId`. */
export interface HeraKeyedSqlClient<
  Owner extends string = string,
  Tx extends HeraKeyedSyncTx<Owner> = HeraKeyedSyncTx<Owner>,
> {
  readonly exec: (
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => SyncEffect<HeraSqlExecResult, HeraSqlError>
  readonly query: HeraSqlQueryFn
  readonly enqueueOutbox: HeraEnqueueOutbox<Owner>
  readonly transactSync: HeraTransactFn<Tx>
  readonly transactWithOutbox: HeraTransactFn<Tx>
  /** Whether the object's storage is initialised; a read on `false` has no tables to read. */
  readonly isInitialized: () => boolean
}

/** Full synchronous SQLite client exposed on `HeraTenantCtx.db` and `TenantDurableObject.db`. */
export interface HeraSqlClient extends HeraTenantDb {
  readonly orgId: OrgId
  readonly exec: HeraKeyedSqlClient<OrgId>["exec"]
  readonly query: HeraSqlQueryFn
  readonly enqueueOutbox: HeraKeyedSqlClient<OrgId>["enqueueOutbox"]
  readonly transactSync: HeraTransactFn
  readonly transactWithOutbox: HeraTransactFn
  readonly isInitialized: () => boolean
}

/**
 * A migration ledger the object kept before it moved onto Hera. Each version it holds
 * is adopted into `_hera_migrations` under the declared migration of that version, never re-run.
 */
export interface HeraLegacyMigrationLedger {
  readonly table: string
  /** Column holding the applied version; defaults to `version`. */
  readonly versionColumn?: string | undefined
}

export interface HeraTenantDurableObjectOptions {
  readonly service?: string | undefined
  readonly migrations?: ReadonlyArray<HeraMigration> | undefined
  readonly legacyMigrationLedger?: HeraLegacyMigrationLedger | undefined
  readonly outboxBatchSize?: number | undefined
  readonly outboxBackoff?: HeraOutboxBackoffOptions | undefined
  /** `strict` (default) keeps written order; `independent` lets a backed-off row hold nothing. */
  readonly outboxOrdering?: HeraOutboxOrdering | undefined
  /** Failed attempts before a row moves to `_hera_outbox_dead_letter` (default 20). */
  readonly outboxMaxAttempts?: number | undefined
  readonly alarmErrorBackoffMs?: number | undefined
  readonly deliverOutboxBatch?: OutboxDeliverySink | undefined
  readonly now?: (() => number) | undefined
  readonly logger?: HeraLogger | undefined
  readonly sink?: LogSink | undefined
  /**
   * `TenantDurableObject` only: name each object `org:<OrgId>:run:<runKey>` (`orgRunDoName`), one
   * object per run. The org still fills `orgId` and the tenant context; `runKey` is decoded from the
   * name. A name without a valid org and run key fails closed. Default `false`: the per-org name.
   */
  readonly runKeyed?: boolean | undefined
}

export type HeraDoJurisdiction =
  | DurableObjectJurisdiction
  | "us"
  | (string & {})

export interface HeraGetTenantStubOptions {
  readonly jurisdiction?: HeraDoJurisdiction | undefined
  readonly env?: Record<string, unknown> | undefined
  readonly useOrgPrefix?: boolean | undefined
}

/** `getTenantRunStub` options: the jurisdiction pin of `getTenantStub`, with no prefix choice. */
export type HeraGetTenantRunStubOptions = Omit<HeraGetTenantStubOptions, "useOrgPrefix">
