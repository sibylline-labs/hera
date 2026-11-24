import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { HeraError } from "../../../core/errors/index.js"
import { type OrgId } from "../../../core/schema/index.js"
import {
  type ExtractSyncYieldError,
  type HeraEnqueueOutbox,
  type HeraKeyedSqlClient,
  type HeraKeyedSyncTx,
  type HeraOutboxRecord,
  HeraSqlError,
  type HeraSqlExecResult,
  type SyncEffect,
  SyncEffectTypeId,
  SyncTxAsyncViolationError,
  type SyncYieldable,
} from "../types.js"
import type { HeraStorageInitializer } from "../migrations/lazy-init.js"
import type { AnyOutboxEventInput, HeraOrderedOutboxRecord } from "../outbox/types.js"
import { captureTxContext } from "./carried-context.js"
import {
  executeSqlCursor,
  isAsyncFiberCause,
  querySqlCursor,
  summarizeRedactedReason,
  wrapSqlError,
} from "./storage-adapter.js"

export function brandSyncEffect<A, E = never, R = never>(
  effect: Effect.Effect<A, E, R>
): SyncEffect<A, E, R> {
  try {
    Object.defineProperty(effect, SyncEffectTypeId, {
      value: SyncEffectTypeId,
      enumerable: false,
      configurable: true,
    })
  } catch {
    // Frozen Effect primitives still carry the compile-time SyncEffect brand.
  }
  return effect as SyncEffect<A, E, R>
}

/**
 * Combinators for constructing synchronous Effects inside `ctx.db.transactSync`
 * and `ctx.db.transactWithOutbox`.
 */
export const SyncTx = {
  succeed<A>(value: A): SyncEffect<A> {
    return brandSyncEffect(Effect.succeed(value))
  },

  fail<E>(error: E): SyncEffect<never, E> {
    return brandSyncEffect(Effect.fail(error))
  },

  die(defect: unknown): SyncEffect<never> {
    return brandSyncEffect(Effect.die(defect))
  },

  sync<A>(evaluate: () => A): SyncEffect<A> {
    return brandSyncEffect(Effect.sync(evaluate))
  },

  try<A, E = HeraSqlError>(options: {
    readonly try: () => A
    readonly catch: (error: unknown) => E
  }): SyncEffect<A, E> {
    return brandSyncEffect(Effect.try({ try: options.try, catch: options.catch }))
  },

  gen<Eff extends SyncYieldable<any, any>, AEff>(
    body: () => Generator<Eff, AEff, never>
  ): SyncEffect<AEff, ExtractSyncYieldError<Eff>> {
    return brandSyncEffect(
      Effect.gen(
        body as unknown as () => Generator<
          Effect.Effect<any, any, never>,
          AEff,
          never
        >
      )
    )
  },

  map<A, B, E>(
    self: SyncEffect<A, E>,
    f: (value: A) => B
  ): SyncEffect<B, E> {
    return brandSyncEffect(Effect.map(self, f))
  },

  flatMap<A, B, E1, E2>(
    self: SyncEffect<A, E1>,
    f: (value: A) => SyncEffect<B, E2>
  ): SyncEffect<B, E1 | E2> {
    return brandSyncEffect(Effect.flatMap(self, f))
  },
} as const

class SyncTxRollbackSignal {
  readonly cause: Cause.Cause<unknown>
  constructor(cause: Cause.Cause<unknown>) {
    this.cause = cause
  }
}

export function execSqlSync(
  sqlStorage: SqlStorage,
  sql: string,
  params?: ReadonlyArray<unknown>
): SyncEffect<HeraSqlExecResult, HeraSqlError> {
  return SyncTx.try({
    try: () => executeSqlCursor(sqlStorage, sql, params),
    catch: wrapSqlError("exec", "SQL exec failed"),
  })
}

export function querySqlSync<Row = Record<string, unknown>>(
  sqlStorage: SqlStorage,
  sql: string,
  params?: ReadonlyArray<unknown>,
  rowSchema?: Schema.Top
): SyncEffect<ReadonlyArray<Row>, HeraSqlError> {
  return SyncTx.try({
    try: () => querySqlCursor<Row>(sqlStorage, sql, params, rowSchema),
    catch: wrapSqlError(
      rowSchema !== undefined ? "query.decode" : "query",
      "SQL query failed",
      rowSchema !== undefined
        ? "SQL query row failed schema validation"
        : undefined
    ),
  })
}

function resolveSyncTxEffect<A, E>(
  input: unknown,
  txHandle: HeraKeyedSyncTx
): Effect.Effect<A, E, never> {
  if (typeof input === "function") {
    const fnResult = (input as (tx: HeraKeyedSyncTx) => unknown)(txHandle)
    if (
      typeof fnResult === "object" &&
      fnResult !== null &&
      "next" in fnResult &&
      typeof (fnResult as Generator).next === "function"
    ) {
      return Effect.gen(
        () => fnResult as Generator<any, A, never>
      ) as Effect.Effect<A, E, never>
    }
    return fnResult as Effect.Effect<A, E, never>
  }
  return input as Effect.Effect<A, E, never>
}

/**
 * Builds a Durable Object's `db`. With an `orgId` (a tenant DO) the client and its tx handle carry
 * it, the `HeraSqlClient` shape; without one (a keyed DO) they do not.
 */
export function createHeraSqlClient(options: {
  readonly orgId?: OrgId | undefined
  readonly storage: DurableObjectStorage
  readonly enqueueOutbox: (
    event: AnyOutboxEventInput
  ) => SyncEffect<HeraOutboxRecord<string> | HeraOrderedOutboxRecord<string>, HeraSqlError>
  readonly onAfterOutboxCommit: () => void
  readonly storageInit: HeraStorageInitializer
  /** True once `purgeStorage()` passed `beforePurge`: every statement is refused from then. */
  readonly isPurged?: (() => boolean) | undefined
}): HeraKeyedSqlClient<string> {
  const { storageInit } = options
  const isPurged = options.isPurged ?? (() => false)
  const purgedError = (operation: string) => new HeraSqlError({ operation, reason: "Storage was purged; refusing the statement" })
  const unpurged = (operation: string): SyncEffect<void, HeraSqlError> =>
    SyncTx.flatMap(SyncTx.sync(isPurged), (purged): SyncEffect<void, HeraSqlError> =>
      purged ? SyncTx.fail(purgedError(operation)) : SyncTx.succeed(undefined)
    )
  const ensureStorage = (operation: string): SyncEffect<void, HeraSqlError> =>
    SyncTx.try({
      try: () => storageInit.ensure(),
      catch: wrapSqlError(operation, "Storage initialisation failed"),
    })
  const identity = options.orgId === undefined ? {} : { orgId: options.orgId }
  const txHandle: HeraKeyedSyncTx = {
    ...identity,
    exec: (sql, params) =>
      SyncTx.flatMap(
        SyncTx.flatMap(unpurged("exec"), () => ensureStorage("exec")),
        () => execSqlSync(options.storage.sql, sql, params)
      ),
    query: ((
      sql: string,
      params?: ReadonlyArray<unknown>,
      rowSchema?: Schema.Top
    ) =>
      SyncTx.flatMap(unpurged("query"), () =>
        querySqlSync(
          options.storage.sql,
          sql,
          params,
          rowSchema
        )
      )) as HeraKeyedSyncTx["query"],
    // One cast at the overload boundary: the ordered overload's record is the one carrying `seq`.
    enqueueOutbox: ((event: AnyOutboxEventInput) =>
      SyncTx.flatMap(
        SyncTx.flatMap(unpurged("enqueueOutbox"), () => ensureStorage("enqueueOutbox")),
        () => options.enqueueOutbox(event)
      )) as HeraEnqueueOutbox<string>,
    succeed: SyncTx.succeed,
    fail: SyncTx.fail,
    die: SyncTx.die,
    sync: SyncTx.sync,
    try: SyncTx.try,
    gen: SyncTx.gen,
  }

  const runTransactionFrame = <A, E>(
    operation: "transactSync" | "transactWithOutbox",
    input: unknown,
    armOutboxAlarmOnCommit: boolean
  ): SyncEffect<A, E | HeraSqlError | SyncTxAsyncViolationError> =>
    brandSyncEffect(
      Effect.gen(function* () {
        const carried = yield* captureTxContext // the detached body sees only this
        let committedValue!: A
        try {
          options.storage.transactionSync(() => {
            // Read inside the transaction: no event between a caller's check and the write slips past.
            if (isPurged()) throw purgedError(operation)
            storageInit.ensureInline()
            const eff = resolveSyncTxEffect<A, E>(input, txHandle)
            // hera-allow: raw-effect-run
            const exit = Effect.runSyncExit(Effect.provideContext(eff, carried))
            if (exit._tag === "Failure") {
              throw new SyncTxRollbackSignal(exit.cause)
            }
            committedValue = exit.value
          })
        } catch (err) {
          if (err instanceof SyncTxRollbackSignal) {
            if (isAsyncFiberCause(err.cause)) {
              return yield* new SyncTxAsyncViolationError({
                operation,
                reason:
                  "An asynchronous Effect (Effect.promise / Effect.sleep) was yielded inside a synchronous SQLite transaction; transaction rolled back",
              })
            }
            return yield* Effect.failCause(
              err.cause as Cause.Cause<E | HeraSqlError>
            )
          }
          if (
            HeraSqlError.is(err) ||
            SyncTxAsyncViolationError.is(err) ||
            HeraError.isAny(err)
          ) {
            return yield* Effect.fail(err as E | HeraSqlError)
          }
          return yield* new HeraSqlError({
            operation,
            reason: summarizeRedactedReason(
              err,
              "SQLite transaction rolled back"
            ),
          })
        }

        if (armOutboxAlarmOnCommit) {
          options.onAfterOutboxCommit()
        }
        return committedValue
      })
    )

  return {
    ...identity,
    exec: txHandle.exec,
    query: txHandle.query,
    enqueueOutbox: txHandle.enqueueOutbox,
    transactSync: ((input: unknown) =>
      runTransactionFrame(
        "transactSync",
        input,
        false
      )) as HeraKeyedSqlClient["transactSync"],
    transactWithOutbox: ((input: unknown) =>
      runTransactionFrame(
        "transactWithOutbox",
        input,
        true
      )) as HeraKeyedSqlClient["transactWithOutbox"],
    isInitialized: storageInit.isInitialized,
  }
}
