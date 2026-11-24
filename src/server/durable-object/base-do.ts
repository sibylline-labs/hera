import { DurableObject } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { createHeraLogger, type HeraLogger } from "../../core/logger/index.js"
import type { OrgId, RequestId } from "../../core/schema/index.js"
import { type AlarmDriver, StorageAlarmDriver } from "./alarm-driver.js"
import { createHold } from "./hold.js"
import { createJobScheduler } from "./jobs/scheduler.js"
import type { HeraJobRegistry, HeraJobScheduler } from "./jobs/types.js"
import {
  createStorageInitializer,
  guardInitAfterPurge,
  guardInitDuringAlarm,
  type HeraStorageInitializer,
} from "./migrations/lazy-init.js"
import { readAppliedMigrations } from "./migrations/runner.js"
import {
  type AlarmSlotDeps,
  alarmFailureLogger,
  cancelDomainAlarmEffect,
  computeCompositeAlarmAt,
  rearmCompositeAlarmOnWake,
  scheduleDomainAlarmEffect,
  syncCompositeAlarmSlot,
} from "./outbox/alarm-slot.js"
import { runCompositeAlarmEffect } from "./outbox/composite-alarm.js"
import { answerCompositePass } from "./outbox/composite-pass.js"
import { readDeadLetteredOutboxRecords, replayDeadLetteredOutboxRecords } from "./outbox/dead-letter.js"
import { deliverToDefaultQueueSink, drainOutboxBatchEffect } from "./outbox/drainer.js"
import { type HeraOutboxSettings, resolveOutboxSettings } from "./outbox/options.js"
import { DEFAULT_ALARM_ERROR_BACKOFF_MS } from "./outbox/schema.js"
import { runAlarmInvocation } from "./alarm-telemetry.js"
import type { HeraTelemetry, HeraTelemetryHook } from "../../core/telemetry/types.js"
import { type HeraDoorWithin, runDoor, runDoorSync } from "./door.js"
import type { HeraOutboxDeadLetter, HeraOutboxSinkResult } from "./outbox/types.js"
import { enqueueOutboxRecord, readDomainAlarmAt, readNextOutboxRetryAt, readPendingOutboxRecords } from "./outbox/store.js"
import { type BeforePurgeResult, purgeDurableObjectStorage } from "./purge.js"
import { createHeraSqlClient } from "./sql/sync-tx.js"
import type {
  HeraAppliedMigration,
  HeraKeyedSqlClient,
  HeraMigration,
  HeraOutboxDrainResult,
  HeraOutboxRecord,
  HeraSqlError,
  HeraTenantDurableObjectOptions,
  OutboxDeliverySink,
  SyncEffect,
} from "./types.js"

/** Who a Hera Durable Object is: its decoded key, its `OrgId` on a tenant, and what its logs carry. */
export interface HeraDurableObjectIdentity<Key extends string> {
  readonly key: Key
  readonly orgId?: OrgId | undefined
  readonly logFields: Readonly<Record<string, unknown>>
}

/**
 * The spine shared by `KeyedDurableObject` and `TenantDurableObject`: lazy migrations,
 * `this.db`/`SyncTx`, logger, outbox, named jobs and the one composite alarm. It has no `configure`,
 * so each subclass keeps its own without a static-side clash.
 *
 * Extends `DurableObject` from `cloudflare:workers` because workerd exposes Workers RPC only on a
 * class declared that way.
 */
export abstract class HeraDurableObjectBase<
  Env = Record<string, unknown>,
  Key extends string = string,
> extends DurableObject<Env> {
  // Set by the `DurableObject` constructor; redeclared to make them public and readonly.
  declare readonly ctx: DurableObjectState<{}>
  declare readonly env: Env
  readonly key: Key
  readonly service: string
  readonly db: HeraKeyedSqlClient<Key>
  readonly logger: HeraLogger
  /** Named jobs on this object's alarm; narrow with `declare readonly jobs: HeraJobScheduler<...>`. */
  readonly jobs: HeraJobScheduler<string>

  protected readonly now: () => number
  protected readonly outbox: HeraOutboxSettings
  protected readonly alarmErrorBackoffMs: number
  protected readonly logFields: Readonly<Record<string, unknown>>
  protected activeRequestId: RequestId | undefined
  private readonly customOutboxSink: OutboxDeliverySink<any> | undefined
  private readonly storageInit: HeraStorageInitializer
  private purged = false
  private readonly inAlarmPass = createHold()
  private readonly armDeferral = createHold()
  private readonly alarmSlot: AlarmSlotDeps
  private readonly runDueJobs: ReturnType<typeof createJobScheduler>["runDueJobs"]

  protected constructor(
    ctx: DurableObjectState,
    env: Env,
    options: HeraTenantDurableObjectOptions | undefined,
    resolveIdentity: (rawName: string | undefined) => HeraDurableObjectIdentity<Key>
  ) {
    super(ctx, env)
    const stateTestNow = (ctx as { readonly __heraTestNow?: (() => number) | undefined })?.__heraTestNow
    this.now = options?.now ?? stateTestNow ?? (() => Date.now())
    this.service = options?.service ?? this.constructor.name ?? "hera-do"
    this.outbox = resolveOutboxSettings(options)
    this.alarmErrorBackoffMs = Math.max(100, options?.alarmErrorBackoffMs ?? DEFAULT_ALARM_ERROR_BACKOFF_MS)
    this.customOutboxSink = options?.deliverOutboxBatch
    const identity = resolveIdentity(this.ctx?.id?.name)
    const logger = options?.logger ?? createHeraLogger({ service: this.service, sink: options?.sink })
    this.logger = identity.orgId === undefined ? logger : logger.child({ orgId: identity.orgId })
    this.key = identity.key
    this.logFields = identity.logFields
    const statics = this.constructor as unknown as { readonly migrations?: ReadonlyArray<HeraMigration>; readonly jobs?: HeraJobRegistry }
    const init = createStorageInitializer({ ctx: this.ctx, now: this.now, migrations: options?.migrations ?? statics.migrations ?? [], legacyLedger: options?.legacyMigrationLedger })
    this.storageInit = guardInitAfterPurge(guardInitDuringAlarm(init, this.inAlarmPass.held), () => this.purged)
    const logAlarmFailure = alarmFailureLogger({ logger: this.logger, logFields: this.logFields, service: this.service })
    const onArmFailure = logAlarmFailure("hera.alarm.arm_failed")
    let driver: AlarmDriver | undefined
    const slotDriver = (): AlarmDriver => (driver ??= this.createAlarmDriver())
    this.alarmSlot = { storage: this.ctx.storage, now: this.now, driver: slotDriver, onArmFailure,
      armsDeferred: this.armDeferral.held, ordering: this.outbox.ordering }
    const syncAlarmSlot = (): void => void syncCompositeAlarmSlot(this.alarmSlot, this.now())
    this.db = createHeraSqlClient({
      orgId: identity.orgId,
      storage: this.ctx.storage,
      enqueueOutbox: (event) => enqueueOutboxRecord({ storage: this.ctx.storage, orgId: this.key, now: this.now,
        getActiveRequestId: () => this.activeRequestId, event }),
      onAfterOutboxCommit: syncAlarmSlot,
      storageInit: this.storageInit,
      isPurged: () => this.purged,
    }) as HeraKeyedSqlClient<Key>
    const jobs = createJobScheduler({
      storage: this.ctx.storage,
      now: this.now,
      registry: statics.jobs ?? {},
      self: () => this,
      ensureStorage: this.storageInit.ensure,
      isInitialized: this.storageInit.isInitialized,
      syncAlarmSlot,
      backoffMs: this.alarmErrorBackoffMs,
      logger: this.logger,
      logFields: { ...this.logFields, service: this.service },
    })
    this.jobs = jobs.scheduler
    this.runDueJobs = jobs.runDueJobs
    // A wake re-arms a platform alarm lost after its rows were written.
    void this.ctx.blockConcurrencyWhile(() =>
      rearmCompositeAlarmOnWake(this.alarmSlot, this.storageInit.isInitialized).catch(
        logAlarmFailure("hera.alarm.rearm_failed")
      )
    )
  }

  /** True once `purgeStorage()` passed `beforePurge`: `this.db` then refuses every statement. */
  protected isPurged(): boolean { return this.purged }

  /** Whether storage is initialised; false until the first write, and again after `deleteAll()`. */
  isInitialized(): boolean { return this.storageInit.isInitialized() }

  getAppliedMigrations(): ReadonlyArray<HeraAppliedMigration> { return this.isInitialized() ? readAppliedMigrations(this.ctx.storage.sql) : [] }

  getPendingOutboxRecords(): ReadonlyArray<HeraOutboxRecord<Key>> {
    return this.isInitialized() ? (readPendingOutboxRecords(this.ctx.storage.sql) as Array<HeraOutboxRecord<Key>>) : []
  }

  getNextOutboxRetryAt(): number | null {
    return this.isInitialized() ? readNextOutboxRetryAt(this.ctx.storage.sql, this.outbox.ordering) : null
  }

  /** Records moved aside after `outboxMaxAttempts` failed attempts; RPC-callable. */
  getDeadLetteredOutboxRecords(): ReadonlyArray<HeraOutboxDeadLetter<Key>> {
    return this.isInitialized() ? (readDeadLetteredOutboxRecords(this.ctx.storage.sql) as Array<HeraOutboxDeadLetter<Key>>) : []
  }

  /** Moves dead letters (the named ids, or all) back into the outbox, due now; answers the count. */
  replayDeadLetteredOutbox(ids?: ReadonlyArray<string>): number {
    if (!this.isInitialized()) return 0
    const count = replayDeadLetteredOutboxRecords(this.ctx.storage, ids, this.now()).length
    if (count > 0) syncCompositeAlarmSlot(this.alarmSlot, this.now())
    return count
  }

  getDomainAlarmAt(): number | null { return this.isInitialized() ? readDomainAlarmAt(this.ctx.storage.sql) : null }

  getNextCompositeAlarmAt(): number | null {
    return this.isInitialized() ? computeCompositeAlarmAt(this.ctx.storage.sql, this.outbox.ordering) : null
  }

  scheduleDomainAlarm(atMs: number): SyncEffect<void, HeraSqlError> {
    return scheduleDomainAlarmEffect(this.alarmSlot, atMs, this.storageInit.ensure)
  }

  cancelDomainAlarm(): SyncEffect<void, HeraSqlError> {
    return cancelDomainAlarmEffect(this.alarmSlot, this.storageInit.isInitialized)
  }

  protected deliverOutboxBatch(records: ReadonlyArray<HeraOutboxRecord<Key>>): HeraOutboxSinkResult {
    const context = { env: this.env, orgId: this.key, logger: this.logger }
    return deliverToDefaultQueueSink(this.customOutboxSink, records, context)
  }

  protected onDomainAlarm(_nowMs: number): Effect.Effect<number | void, unknown, never> | Promise<number | void> | number | void {
    return undefined
  }

  /** The isolate's `HeraTelemetry`: alarm passes and `runDoor` doors then export as invocations. Default: none. */
  protected telemetry(): HeraTelemetry | undefined { return undefined }

  private doorHook(): HeraTelemetryHook | undefined {
    const telemetry = this.telemetry()
    return telemetry === undefined ? undefined : { telemetry, waitUntil: (p) => this.ctx.waitUntil(p) }
  }

  /** Runs a plain-stub door as an invocation of `telemetry()` (`door.ts`): pass the method's trailing args. */
  protected runDoor<A>(name: string, callArgs: ReadonlyArray<unknown>, body: (within: HeraDoorWithin) => Promise<A>): Promise<A> {
    return runDoor(this.doorHook(), name, callArgs, body)
  }

  /** {@link runDoor} for a synchronous body. */
  protected runDoorSync<A>(name: string, callArgs: ReadonlyArray<unknown>, body: (within: HeraDoorWithin) => A): A {
    return runDoorSync(this.doorHook(), name, callArgs, body)
  }

  /** Runs one alarm pass; `TenantDurableObject` provides its tenant context here. */
  protected runAlarmProgram(program: Effect.Effect<void, never, never>): Promise<void> {
    // hera-allow: raw-effect-run
    return Effect.runPromise(program)
  }

  drainOutbox(nowMs: number = this.now()): Effect.Effect<HeraOutboxDrainResult, never, never> {
    if (!this.isInitialized()) return Effect.succeed({ drained: 0, failed: 0, remaining: 0, nextRetryAt: null })
    return drainOutboxBatchEffect({
      storage: this.ctx.storage,
      logFields: this.logFields,
      nowMs,
      settings: this.outbox,
      logger: this.logger,
      isInitialized: this.storageInit.isInitialized,
      deliverBatch: (batch) => this.deliverOutboxBatch(batch as ReadonlyArray<HeraOutboxRecord<Key>>),
    })
  }

  /** The alarm owner; override to hand it to, say, a Lifecycle host job. Resolved once, lazily. */
  protected createAlarmDriver(): AlarmDriver {
    return new StorageAlarmDriver(this.ctx.storage)
  }

  override async alarm(): Promise<void> {
    if (this.isInitialized()) {
      await this.runAlarmPass(this.now(), (atMs) => this.alarmSlot.driver().set(atMs))
    }
  }

  /**
   * The pass `alarm()` runs, arming nothing; answers the next wake or `null` (`answerCompositePass`)
   * for a host job's `{ rescheduleAt }`. Protected: over RPC, an answer nobody arms strands work.
   */
  protected runCompositePass(): Promise<number | null> {
    return answerCompositePass({
      isInitialized: this.storageInit.isInitialized,
      deferArms: this.armDeferral.during,
      runPass: (arm) => this.runAlarmPass(this.now(), arm),
      pendingAt: () => this.getNextCompositeAlarmAt(),
      now: this.now,
    })
  }

  /** Runs before `purgeStorage()` deletes anything; a failure stops the purge with the data intact. */
  protected beforePurge(): BeforePurgeResult { return undefined }

  /** Empties this object: alarm, `beforePurge`, `deleteAll`, then a deferred reset (`purge.ts`). */
  purgeStorage(): Promise<void> {
    return purgeDurableObjectStorage({
      ctx: this.ctx,
      driver: this.alarmSlot.driver(),
      beforePurge: () => this.beforePurge(),
      markPurged: () => void (this.purged = true),
    })
  }

  private async runAlarmPass(nowMs: number, arm: (atMs: number) => Promise<void>): Promise<void> {
    const program = runCompositeAlarmEffect({
      storage: this.ctx.storage,
      arm,
      logFields: this.logFields,
      service: this.service,
      nowMs,
      alarmErrorBackoffMs: this.alarmErrorBackoffMs,
      logger: this.logger,
      drainOutbox: (atMs) => this.drainOutbox(atMs),
      onDomainAlarm: (atMs) => this.onDomainAlarm(atMs),
      scheduleDomainAlarm: (atMs) => this.scheduleDomainAlarm(atMs),
      runDueJobs: (atMs) => this.runDueJobs(atMs),
      isInitialized: this.storageInit.isInitialized,
      ordering: this.outbox.ordering,
    })
    const { service, logger } = this
    const waitUntil = (p: Promise<unknown>) => this.ctx.waitUntil(p)
    const run = (p: Effect.Effect<void, never, never>) => this.runAlarmProgram(p)
    await this.inAlarmPass.during(() => runAlarmInvocation({ telemetry: this.telemetry(), waitUntil, service, logger, program, run }))
  }
}
