import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  computeOutboxBackoffMs,
  Hera,
  HeraCtx,
  HeraError,
  type HeraMigration,
  HeraMigrationError,
  type HeraOutboxRecord,
  HeraSchema,
  HeraSqlError,
  HeraTenantCtx,
  OrgId,
  SyncTx,
  SyncTxAsyncViolationError,
  TenantDurableObject,
  TenantIdentityError,
  YakId,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"
import { SAMPLE_IDS } from "../src/testing/index"

const TEST_MIGRATIONS: ReadonlyArray<HeraMigration> = [
  {
    version: 1,
    name: "001_create_yaks",
    sql: [
      `CREATE TABLE yaks (
        id TEXT NOT NULL PRIMARY KEY,
        org_id TEXT NOT NULL,
        title TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX idx_yaks_org ON yaks (org_id)`,
    ],
  },
  {
    version: 2,
    name: "002_add_notes_table",
    sql: `CREATE TABLE yak_notes (
      note_id TEXT NOT NULL PRIMARY KEY,
      yak_id TEXT NOT NULL,
      body TEXT NOT NULL
    )`,
  },
]

const YakRowSchema = Schema.Struct({
  id: YakId,
  org_id: OrgId,
  title: Schema.NonEmptyString,
  count: Schema.Number,
})

const QuotaExceededError = HeraError.define("QuotaExceededError", {
  code: "quota_exceeded",
  publicMessage: "Tenant yak quota exceeded",
  fields: {
    orgId: OrgId,
    limit: Schema.Number,
  },
})

interface TestEnv {
  readonly EVENTS?: {
    sendBatch: (
      messages: Iterable<{ readonly body: unknown }>
    ) => Promise<void>
  }
  readonly HERA_LOCAL_WORKERD?: string
}

class YakTenantDO extends Hera.TenantDurableObject.configure<TestEnv>({
  service: "polaris-yak",
  migrations: TEST_MIGRATIONS,
  outboxBackoff: {
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterRatio: 0,
  },
  alarmErrorBackoffMs: 15_000,
}) {
  readonly domainAlarmFires: Array<number> = []
  domainAlarmBehavior: "ok" | "reschedule" | "defect" = "ok"
  nextRescheduleAt: number | undefined

  protected override onDomainAlarm(
    nowMs: number
  ): Effect.Effect<number | void, unknown, never> {
    this.domainAlarmFires.push(nowMs)
    if (this.domainAlarmBehavior === "defect") {
      return Effect.die(
        new Error("FATAL_DOMAIN_ALARM_CRASH_sk_live_secret_987654321")
      )
    }
    if (
      this.domainAlarmBehavior === "reschedule" &&
      this.nextRescheduleAt !== undefined
    ) {
      return Effect.succeed(this.nextRescheduleAt)
    }
    return Effect.void
  }
}

/** Storage initialises on the first write; an empty committed transaction is one. */
function initialized<Do extends TenantDurableObject<any>>(tenantDo: Do): Do {
  // hera-allow: raw-effect-run
  Effect.runSync(tenantDo.db.transactSync(SyncTx.succeed(undefined)))
  return tenantDo
}

describe("Hera.TenantDurableObject — SyncTx SQLite Atomicity, Transactional Outbox & Composite Alarm", () => {
  describe("Single-site this.ctx.id.name -> OrgId branding & Hera.getTenantStub", () => {
    it("brands valid raw OrgId and org:<OrgId> DO names into this.orgId and HeraTenantCtx.orgId", async () => {
      const rawHarness = makeTestDurableObjectState({
        idName: SAMPLE_IDS.orgId,
      })
      const rawDo = new YakTenantDO(rawHarness.state, {})
      expect(rawDo.orgId).toBe(SAMPLE_IDS.orgId)

      const prefixedHarness = makeTestDurableObjectState({
        idName: Hera.orgDoName(SAMPLE_IDS.orgId),
      })
      const prefixedDo = new YakTenantDO(prefixedHarness.state, {})
      expect(prefixedDo.orgId).toBe(SAMPLE_IDS.orgId)

      const observedCtx = await rawDo.runWithTenantCtx(
        Effect.gen(function* () {
          const tenant = yield* HeraTenantCtx
          const base = yield* HeraCtx
          return {
            tenantOrgId: tenant.orgId,
            baseOrgId: Option.getOrThrow(base.orgId),
            dbOrgId: tenant.db?.orgId,
            service: tenant.service,
          }
        })
      )

      expect(observedCtx).toEqual({
        tenantOrgId: SAMPLE_IDS.orgId,
        baseOrgId: SAMPLE_IDS.orgId,
        dbOrgId: SAMPLE_IDS.orgId,
        service: "polaris-yak",
      })
    })

    it("fails closed with a redacted TenantIdentityError when ctx.id.name is missing or malformed, writing zero tables", async () => {
      const secretInvalidName = "org_bad_secret_token_value_12345"
      const badHarness = makeTestDurableObjectState({
        idName: secretInvalidName,
      })

      let caughtError: unknown
      try {
        new YakTenantDO(badHarness.state, {})
      } catch (err) {
        caughtError = err
      }

      expect(TenantIdentityError.is(caughtError)).toBe(true)
      const identityErr = caughtError as TenantIdentityError
      expect(identityErr.code).toBe("invalid_subject")
      expect(identityErr.status).toBe(400)
      const res = identityErr.toResponse({ requestId: SAMPLE_IDS.requestId })
      expect(res.status).toBe(400)
      const text = await res.text()
      expect(text).not.toContain(secretInvalidName)

      // Verify zero tables were created in SQLite
      const tables = badHarness.sqliteDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
      expect(tables).toHaveLength(0)

      // Anonymous DO (missing id.name) also fails closed
      const anonHarness = makeTestDurableObjectState({ idName: null })
      expect(() => new YakTenantDO(anonHarness.state, {})).toThrowError(
        TenantIdentityError
      )
    })

    it("enforces branded OrgId on Hera.getTenantStub at compile time and runtime, with optional jurisdiction support", () => {
      const idFromNameCalls: Array<string> = []
      const jurisdictionCalls: Array<string> = []

      const fakeStub = { id: "stub-1" } as unknown as DurableObjectStub<undefined>
      const fakeNamespace = {
        idFromName(name: string) {
          idFromNameCalls.push(name)
          return { name, toString: () => name } as unknown as DurableObjectId
        },
        get(_id: DurableObjectId) {
          return fakeStub
        },
        jurisdiction(j: DurableObjectJurisdiction) {
          jurisdictionCalls.push(j)
          return this
        },
      } as unknown as DurableObjectNamespace<undefined>

      // @ts-expect-error getTenantStub must reject unbranded string at compile time
      const _compileCheck = () => Hera.getTenantStub(fakeNamespace, "org_raw")
      expect(typeof _compileCheck).toBe("function")

      const stub1 = Hera.getTenantStub(fakeNamespace, SAMPLE_IDS.orgId)
      expect(stub1).toBe(fakeStub)
      expect(idFromNameCalls).toEqual([SAMPLE_IDS.orgId])

      const stub2 = Hera.getTenantStub(fakeNamespace, SAMPLE_IDS.orgId, {
        jurisdiction: "us",
        useOrgPrefix: true,
      })
      expect(stub2).toBe(fakeStub)
      expect(jurisdictionCalls).toEqual(["us"])
      expect(idFromNameCalls).toEqual([
        SAMPLE_IDS.orgId,
        `org:${SAMPLE_IDS.orgId}`,
      ])

      // Runtime defense-in-depth if someone casts an invalid string as OrgId
      expect(() =>
        Hera.getTenantStub(
          fakeNamespace,
          "not_an_org_id" as unknown as OrgId
        )
      ).toThrowError(TenantIdentityError)
    })

    it("boots on a consumer's live org:<bare ULID> name and keeps the bare OrgId verbatim", async () => {
      const bareUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
      const bareOrgId = OrgId.make(bareUlid)
      const nowMs = 1_700_000_200_000
      const harness = makeTestDurableObjectState({ idName: `org:${bareUlid}` })
      const tenantDo = new YakTenantDO(harness.state, {}, { now: () => nowMs })
      expect(tenantDo.orgId).toBe(bareUlid)

      const observed = await tenantDo.runWithTenantCtx(
        Effect.gen(function* () {
          const tenant = yield* HeraTenantCtx
          return { orgId: tenant.orgId, dbOrgId: tenant.db?.orgId }
        })
      )
      expect(observed).toEqual({ orgId: bareUlid, dbOrgId: bareUlid })

      const record = await tenantDo.runWithTenantCtx(
        tenantDo.db.transactWithOutbox(function* (tx) {
          return yield* tx.enqueueOutbox({
            id: "evt_bare_1",
            type: "yak.created@1",
            payload: {},
          })
        }),
        { requestId: SAMPLE_IDS.requestId }
      )
      expect(record.orgId).toBe(bareUlid)
      expect(tenantDo.getPendingOutboxRecords()[0]?.orgId).toBe(bareUlid)

      const rawHarness = makeTestDurableObjectState({ idName: bareUlid })
      expect(new YakTenantDO(rawHarness.state, {}).orgId).toBe(bareOrgId)

      for (const name of [
        `org:${bareUlid}:srn:polaris:yak`,
        `org:${bareUlid.toLowerCase()}`,
        `org:org_org_${bareUlid}`,
      ]) {
        const bad = makeTestDurableObjectState({ idName: name })
        expect(() => new YakTenantDO(bad.state, {})).toThrowError(
          TenantIdentityError
        )
      }
    })

    it("pins exact stub names for the canonical org_ form and the bare alias", () => {
      const names: Array<string> = []
      const namespace = {
        idFromName(name: string) {
          names.push(name)
          return { name, toString: () => name } as unknown as DurableObjectId
        },
        get: () => ({}) as DurableObjectStub<undefined>,
      } as unknown as DurableObjectNamespace<undefined>

      const bareOrgId = OrgId.make("01ARZ3NDEKTSV4RRFFQ69G5FAV")
      Hera.getTenantStub(namespace, bareOrgId, { useOrgPrefix: true })
      Hera.getTenantStub(namespace, bareOrgId)
      Hera.getTenantStub(namespace, SAMPLE_IDS.orgId, { useOrgPrefix: true })

      expect(names).toEqual([
        "org:01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        `org:${SAMPLE_IDS.orgId}`,
      ])
      expect(Hera.orgDoName(bareOrgId)).toBe("org:01ARZ3NDEKTSV4RRFFQ69G5FAV")
      expect(Option.getOrNull(Hera.parseOrgDoName("org:01ARZ3NDEKTSV4RRFFQ69G5FAV"))).toBe(
        "01ARZ3NDEKTSV4RRFFQ69G5FAV"
      )
    })

    it("supports local workerd jurisdiction fallback only when HERA_LOCAL_WORKERD=1", () => {
      const fakeStub = { id: "stub-local" } as unknown as DurableObjectStub<undefined>
      const workerdNamespace = {
        idFromName(name: string) {
          return { name, toString: () => name } as unknown as DurableObjectId
        },
        get() {
          return fakeStub
        },
        jurisdiction() {
          throw new Error(
            "Jurisdiction restrictions are not implemented in workerd."
          )
        },
      } as unknown as DurableObjectNamespace<undefined>

      expect(() =>
        Hera.getTenantStub(workerdNamespace, SAMPLE_IDS.orgId, {
          jurisdiction: "us",
          env: {},
        })
      ).toThrow("Jurisdiction restrictions are not implemented")

      const fallbackStub = Hera.getTenantStub(
        workerdNamespace,
        SAMPLE_IDS.orgId,
        {
          jurisdiction: "us",
          env: { HERA_LOCAL_WORKERD: "1" },
        }
      )
      expect(fallbackStub).toBe(fakeStub)
    })
  })

  describe("blockConcurrencyWhile SQLite migrations (_hera_migrations)", () => {
    it("applies migrations in ascending version order and is idempotent across DO wake cycles", () => {
      const harness = makeTestDurableObjectState({
        idName: SAMPLE_IDS.orgId,
      })
      let currentNow = 1_700_000_000_000
      const doInstance1 = new YakTenantDO(harness.state, {}, {
        now: () => currentNow,
      })
      expect(doInstance1.getAppliedMigrations()).toEqual([])
      initialized(doInstance1)

      expect(doInstance1.getAppliedMigrations()).toEqual([
        {
          version: 1,
          name: "001_create_yaks",
          appliedAt: 1_700_000_000_000,
        },
        {
          version: 2,
          name: "002_add_notes_table",
          appliedAt: 1_700_000_000_000,
        },
      ])

      // Simulate hibernation wake with a new migration v3 added
      currentNow = 1_700_000_005_000
      const doInstance2 = new YakTenantDO(harness.state, {}, {
        now: () => currentNow,
        migrations: [
          ...TEST_MIGRATIONS,
          {
            version: 3,
            name: "003_add_tags",
            sql: "ALTER TABLE yaks ADD COLUMN tag TEXT DEFAULT 'general'",
          },
        ],
      })

      expect(doInstance2.getAppliedMigrations()).toEqual([
        {
          version: 1,
          name: "001_create_yaks",
          appliedAt: 1_700_000_000_000,
        },
        {
          version: 2,
          name: "002_add_notes_table",
          appliedAt: 1_700_000_000_000,
        },
        {
          version: 3,
          name: "003_add_tags",
          appliedAt: 1_700_000_005_000,
        },
      ])
    })

    it("fails closed with HeraMigrationError and rolls back on duplicate versions, name drift, or bad SQL", () => {
      const dupHarness = makeTestDurableObjectState()
      expect(
        () =>
          new YakTenantDO(dupHarness.state, {}, {
            migrations: [
              { version: 1, name: "first", sql: "CREATE TABLE t1 (id TEXT)" },
              { version: 1, name: "second", sql: "CREATE TABLE t2 (id TEXT)" },
            ],
          })
      ).toThrowError(HeraMigrationError)

      const badSqlHarness = makeTestDurableObjectState()
      const badSqlDo = new YakTenantDO(badSqlHarness.state, {}, {
        migrations: [
          { version: 1, name: "good", sql: "CREATE TABLE t_ok (id TEXT)" },
          { version: 2, name: "broken", sql: "THIS IS NOT VALID SQL" },
        ],
      })
      // hera-allow: raw-effect-run
      const badSqlExit = Effect.runSyncExit(badSqlDo.db.transactSync(SyncTx.succeed(undefined)))
      expect(badSqlExit._tag).toBe("Failure")
      if (badSqlExit._tag === "Failure") {
        const reason = badSqlExit.cause.reasons[0] as { readonly error?: unknown }
        expect(reason.error).toBeInstanceOf(HeraMigrationError)
      }
      expect(() => new YakTenantDO(badSqlHarness.state, {}, {
        migrations: [{ version: 1, name: "good", sql: "CREATE TABLE t_ok (id TEXT)" }],
      })).not.toThrow()

      // Migrations run inside the first write's storage.transactionSync, so v1 was also rolled back!
      const tables = badSqlHarness.sqliteDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't_ok'"
        )
        .all()
      expect(tables).toHaveLength(0)
    })
  })

  describe("SyncTx synchronous SQLite atomicity (ctx.db.query, ctx.db.exec, transactSync)", () => {
    it("executes parameterized SQL and decodes rows via HeraSchema in ctx.db.query", async () => {
      const harness = makeTestDurableObjectState()
      const tenantDo = new YakTenantDO(harness.state, {})

      const rows = await tenantDo.runWithTenantCtx(
        Effect.gen(function* () {
          const ctx = yield* HeraTenantCtx
          yield* tenantDo.db.exec(
            "INSERT INTO yaks (id, org_id, title, count) VALUES (?, ?, ?, ?)",
            [SAMPLE_IDS.yakId, ctx.orgId, "First yak", 3]
          )
          return yield* tenantDo.db.query(
            "SELECT id, org_id, title, count FROM yaks WHERE org_id = ?",
            [ctx.orgId],
            YakRowSchema
          )
        })
      )

      expect(rows).toEqual([
        {
          id: SAMPLE_IDS.yakId,
          org_id: SAMPLE_IDS.orgId,
          title: "First yak",
          count: 3,
        },
      ])

      // Invalid stored row fails schema decoding with HeraSqlError without leaking raw value
      await tenantDo.runWithTenantCtx(
        tenantDo.db.exec(
          "INSERT INTO yaks (id, org_id, title, count) VALUES (?, ?, ?, ?)",
          ["NOT_A_VALID_YAK_ID_SECRET_777", SAMPLE_IDS.orgId, "Bad yak", 1]
        )
      )

      const badDecodeExit = await Effect.runPromiseExit(
        tenantDo.db.query(
          "SELECT id, org_id, title, count FROM yaks",
          [],
          YakRowSchema
        )
      )
      expect(badDecodeExit._tag).toBe("Failure")
      const jsonText = JSON.stringify(badDecodeExit)
      expect(jsonText).not.toContain("NOT_A_VALID_YAK_ID_SECRET_777")
    })

    it("rejects Effect.promise and Effect.sleep inside transactSync and transactWithOutbox at compile time (@ts-expect-error) and rolls back at runtime", async () => {
      const harness = makeTestDurableObjectState()
      const tenantDo = initialized(new YakTenantDO(harness.state, {}))

      // 1. Direct async Effect passed to transactSync (compile-time error + runtime rollback)
      const asyncPromiseProgram = tenantDo.db.transactSync(
        // @ts-expect-error Effect.promise returns an unbranded async Effect and must be rejected at compile time
        Effect.promise(() => Promise.resolve("async-forbidden"))
      )
      const exit1 = await Effect.runPromiseExit(asyncPromiseProgram)
      expect(exit1._tag).toBe("Failure")

      // 2. Direct Effect.sleep passed to transactWithOutbox (compile-time error + runtime rollback)
      const asyncSleepProgram = tenantDo.db.transactWithOutbox(
        // @ts-expect-error Effect.sleep is asynchronous and must be rejected by transactWithOutbox at compile time
        Effect.sleep("10 millis")
      )
      const exit2 = await Effect.runPromiseExit(asyncSleepProgram)
      expect(exit2._tag).toBe("Failure")

      // 3. Generator yielding a sync SQL write followed by a forced async Effect must roll back the SQL write!
      const mixedAsyncGen = tenantDo.db.transactWithOutbox(
        // @ts-expect-error Yielding an async Effect inside a SyncTx generator must fail at compile time
        function* (tx) {
          yield* tx.exec(
            "INSERT INTO yaks (id, org_id, title, count) VALUES (?, ?, ?, ?)",
            [SAMPLE_IDS.yakId, SAMPLE_IDS.orgId, "Should be rolled back", 1]
          )
          yield* tx.enqueueOutbox({
            type: "yak.created@1",
            payload: { yakId: SAMPLE_IDS.yakId },
          })
          yield* Effect.promise(() => Promise.resolve("illegal-async-hop"))
          return "unreachable"
        }
      )

      const exit3 = await Effect.runPromiseExit(mixedAsyncGen)
      expect(exit3._tag).toBe("Failure")
      if (exit3._tag === "Failure") {
        const err = exit3.cause.reasons[0]
        expect(err).toBeDefined()
      }

      // Verify both the yak row AND the outbox row were rolled back by SQLite SAVEPOINT
      const remainingYaks = await Effect.runPromise(
        tenantDo.db.query("SELECT * FROM yaks")
      )
      expect(remainingYaks).toHaveLength(0)
      expect(tenantDo.getPendingOutboxRecords()).toHaveLength(0)
      expect(harness.rollbackCount()).toBeGreaterThanOrEqual(3)
    })

    it("rolls back all domain SQL mutations when transactSync fails with a HeraError, Effect.fail, or defect", async () => {
      const harness = makeTestDurableObjectState()
      const tenantDo = initialized(new YakTenantDO(harness.state, {}))

      const failingTx = tenantDo.db.transactSync(function* (tx) {
        yield* tx.exec(
          "INSERT INTO yaks (id, org_id, title, count) VALUES (?, ?, ?, ?)",
          [SAMPLE_IDS.yakId, SAMPLE_IDS.orgId, "Uncommitted yak", 5]
        )
        yield* tx.exec(
          "INSERT INTO yak_notes (note_id, yak_id, body) VALUES (?, ?, ?)",
          ["note_1", SAMPLE_IDS.yakId, "Uncommitted note"]
        )
        return yield* new QuotaExceededError({
          orgId: SAMPLE_IDS.orgId,
          limit: 0,
        })
      })

      const exit = await Effect.runPromiseExit(failingTx)
      expect(exit._tag).toBe("Failure")

      const yaks = await Effect.runPromise(
        tenantDo.db.query("SELECT * FROM yaks")
      )
      const notes = await Effect.runPromise(
        tenantDo.db.query("SELECT * FROM yak_notes")
      )
      expect(yaks).toHaveLength(0)
      expect(notes).toHaveLength(0)
    })
  })

  describe("Transactional Outbox (_hera_outbox) & Exponential Backoff Drain", () => {
    it("atomically commits or rolls back domain rows and _hera_outbox rows in transactWithOutbox", async () => {
      const harness = makeTestDurableObjectState()
      const nowMs = 1_700_000_100_000
      const tenantDo = initialized(new YakTenantDO(harness.state, {}, { now: () => nowMs }))

      // 1. Failing transaction rolls back BOTH domain row and _hera_outbox row
      const failedOutboxTx = tenantDo.db.transactWithOutbox(function* (tx) {
        yield* tx.exec(
          "INSERT INTO yaks (id, org_id, title, count) VALUES (?, ?, ?, ?)",
          [SAMPLE_IDS.yakId, SAMPLE_IDS.orgId, "Rolled back yak", 1]
        )
        yield* tx.enqueueOutbox({
          id: "evt_rollback_1",
          type: "yak.created@1",
          payload: { yakId: SAMPLE_IDS.yakId },
        })
        return yield* tx.fail(
          new QuotaExceededError({ orgId: SAMPLE_IDS.orgId, limit: 10 })
        )
      })

      const failExit = await Effect.runPromiseExit(failedOutboxTx)
      expect(failExit._tag).toBe("Failure")
      expect(
        await Effect.runPromise(tenantDo.db.query("SELECT * FROM yaks"))
      ).toHaveLength(0)
      expect(tenantDo.getPendingOutboxRecords()).toHaveLength(0)
      expect(harness.getScheduledAlarm()).toBeNull()

      // 2. Successful transaction commits BOTH domain row and _hera_outbox row and arms DO alarm
      const committed = await tenantDo.runWithTenantCtx(
        tenantDo.db.transactWithOutbox(function* (tx) {
          yield* tx.exec(
            "INSERT INTO yaks (id, org_id, title, count) VALUES (?, ?, ?, ?)",
            [SAMPLE_IDS.yakId, SAMPLE_IDS.orgId, "Committed yak", 2]
          )
          const record = yield* tx.enqueueOutbox({
            id: "evt_commit_1",
            type: "yak.created@1",
            payload: { yakId: SAMPLE_IDS.yakId, count: 2 },
          })
          return record
        }),
        { requestId: SAMPLE_IDS.requestId }
      )

      expect(committed.id).toBe("evt_commit_1")
      expect(committed.orgId).toBe(SAMPLE_IDS.orgId)
      expect(committed.requestId).toBe(SAMPLE_IDS.requestId)

      const yaks = await Effect.runPromise(
        tenantDo.db.query("SELECT * FROM yaks", [], YakRowSchema)
      )
      expect(yaks).toHaveLength(1)
      expect(yaks[0]?.title).toBe("Committed yak")

      const pending = tenantDo.getPendingOutboxRecords()
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        id: "evt_commit_1",
        orgId: SAMPLE_IDS.orgId,
        type: "yak.created@1",
        payload: { yakId: SAMPLE_IDS.yakId, count: 2 },
        requestId: SAMPLE_IDS.requestId,
        attempts: 0,
        nextAttemptAt: nowMs,
      })

      // Alarm was immediately armed for the record's nextAttemptAt, clamped to now + 1
      expect(harness.getScheduledAlarm()).toBe(nowMs + 1)
    })

    it("retries outbox drain with exponential backoff on 503 failure and deletes rows upon successful delivery", async () => {
      let currentNow = 1_700_000_200_000
      let shouldFail503 = true
      const deliveredBatches: Array<ReadonlyArray<HeraOutboxRecord>> = []
      const logEntries: Array<Record<string, unknown>> = []

      const harness = makeTestDurableObjectState()
      const tenantDo = new YakTenantDO(
        harness.state,
        {},
        {
          now: () => currentNow,
          sink: (_line, entry) => {
            logEntries.push(entry)
          },
          deliverOutboxBatch: (batch) => {
            if (shouldFail503) {
              return Promise.reject(
                new Error("503 Service Unavailable: upstream event bus overloaded")
              )
            }
            deliveredBatches.push(batch)
            return Promise.resolve()
          },
        }
      )

      await tenantDo.runWithTenantCtx(
        tenantDo.db.transactWithOutbox(function* (tx) {
          yield* tx.enqueueOutbox({
            id: "evt_backoff_1",
            type: "yak.clustered@1",
            payload: { yakId: SAMPLE_IDS.yakId },
          })
        })
      )

      expect(harness.getScheduledAlarm()).toBe(currentNow + 1)

      // 1st alarm fire: fails with 503 -> attempts = 1, backoff = 1000ms
      await tenantDo.alarm()
      expect(deliveredBatches).toHaveLength(0)
      const afterAttempt1 = tenantDo.getPendingOutboxRecords()
      expect(afterAttempt1).toHaveLength(1)
      expect(afterAttempt1[0]?.attempts).toBe(1)
      expect(afterAttempt1[0]?.nextAttemptAt).toBe(currentNow + 1_000)
      expect(afterAttempt1[0]?.lastError).toContain("503 Service Unavailable")
      expect(harness.getScheduledAlarm()).toBe(currentNow + 1_000)

      // 2nd alarm fire at +1000ms: still 503 -> attempts = 2, backoff = 2000ms
      currentNow += 1_000
      await tenantDo.alarm()
      const afterAttempt2 = tenantDo.getPendingOutboxRecords()
      expect(afterAttempt2[0]?.attempts).toBe(2)
      expect(afterAttempt2[0]?.nextAttemptAt).toBe(currentNow + 2_000)
      expect(harness.getScheduledAlarm()).toBe(currentNow + 2_000)

      // 3rd alarm fire at +2000ms: upstream recovers -> delivered and deleted from _hera_outbox!
      currentNow += 2_000
      shouldFail503 = false
      await tenantDo.alarm()
      expect(deliveredBatches).toHaveLength(1)
      expect(deliveredBatches[0]?.[0]?.id).toBe("evt_backoff_1")
      expect(tenantDo.getPendingOutboxRecords()).toHaveLength(0)

      // Verify computeOutboxBackoffMs progression
      expect(computeOutboxBackoffMs(1, { baseDelayMs: 1_000 })).toBe(1_000)
      expect(computeOutboxBackoffMs(2, { baseDelayMs: 1_000 })).toBe(2_000)
      expect(computeOutboxBackoffMs(3, { baseDelayMs: 1_000 })).toBe(4_000)
      expect(
        computeOutboxBackoffMs(10, { baseDelayMs: 1_000, maxDelayMs: 10_000 })
      ).toBe(10_000)
    })
  })

  describe("Composite Single-Slot Alarm Multiplexer & catchCause Recovery", () => {
    it("multiplexes outbox retry and _hera_domain_alarm_at via Math.min(nextOutboxRetryAt, nextDomainAlarmAt)", async () => {
      let currentNow = 1_700_000_500_000
      const delivered: Array<string> = []
      const harness = makeTestDurableObjectState()
      const tenantDo = new YakTenantDO(
        harness.state,
        {},
        {
          now: () => currentNow,
          deliverOutboxBatch: (batch) => {
            for (const item of batch) {
              delivered.push(item.id)
            }
          },
        }
      )

      const domainAlarmAt = currentNow + 10_000
      const outboxAvailableAt = currentNow + 4_000

      // Schedule a domain alarm at T + 10_000
      await Effect.runPromise(tenantDo.scheduleDomainAlarm(domainAlarmAt))
      expect(tenantDo.getDomainAlarmAt()).toBe(domainAlarmAt)
      expect(harness.getScheduledAlarm()).toBe(domainAlarmAt)

      // Enqueue an outbox event due earlier at T + 4_000
      await tenantDo.runWithTenantCtx(
        tenantDo.db.transactWithOutbox(function* (tx) {
          yield* tx.enqueueOutbox({
            id: "evt_mux_1",
            type: "yak.created@1",
            payload: { step: 1 },
            availableAt: outboxAvailableAt,
          })
        })
      )

      // Single-slot DO alarm must be Math.min(T + 4_000, T + 10_000) = T + 4_000
      expect(tenantDo.getNextCompositeAlarmAt()).toBe(outboxAvailableAt)
      expect(harness.getScheduledAlarm()).toBe(outboxAvailableAt)

      // Advance clock to T + 4_000 and fire alarm():
      // Outbox drains, domain alarm (due at T + 10_000) does NOT fire yet, and DO alarm re-arms to T + 10_000!
      currentNow = outboxAvailableAt
      await tenantDo.alarm()
      expect(delivered).toEqual(["evt_mux_1"])
      expect(tenantDo.getPendingOutboxRecords()).toHaveLength(0)
      expect(tenantDo.domainAlarmFires).toHaveLength(0)
      expect(tenantDo.getDomainAlarmAt()).toBe(domainAlarmAt)
      expect(harness.getScheduledAlarm()).toBe(domainAlarmAt)

      // Now advance clock to T + 10_000 and fire alarm():
      // Domain alarm fires and clears _hera_domain_alarm_at!
      currentNow = domainAlarmAt
      await tenantDo.alarm()
      expect(tenantDo.domainAlarmFires).toEqual([domainAlarmAt])
      expect(tenantDo.getDomainAlarmAt()).toBeNull()
      expect(tenantDo.getNextCompositeAlarmAt()).toBeNull()
    })

    it("catches unhandled defects in alarm() via Effect.catchCause, logs a redacted error, and arms a fallback retry alarm", async () => {
      const currentNow = 1_700_000_800_000
      const logs: Array<Record<string, unknown>> = []
      const harness = makeTestDurableObjectState()
      const tenantDo = new YakTenantDO(
        harness.state,
        {},
        {
          now: () => currentNow,
          alarmErrorBackoffMs: 15_000,
          sink: (_line, entry) => {
            logs.push(entry)
          },
        }
      )

      tenantDo.domainAlarmBehavior = "defect"
      await Effect.runPromise(tenantDo.scheduleDomainAlarm(currentNow))

      // alarm() must NOT throw even when onDomainAlarm dies with a defect
      await expect(tenantDo.alarm()).resolves.toBeUndefined()

      // Fallback alarm must be scheduled at currentNow + 15_000 so the alarm loop never dies
      expect(harness.getScheduledAlarm()).toBe(currentNow + 15_000)

      // Error log was emitted with orgId and redacted reason
      const defectLog = logs.find((l) => l.msg === "hera.alarm.defect")
      expect(defectLog).toBeDefined()
      const serializedLog = JSON.stringify(defectLog)
      expect(serializedLog).toContain(SAMPLE_IDS.orgId)
      expect(serializedLog).not.toContain("sk_live_secret_987654321")
    })
  })
})
