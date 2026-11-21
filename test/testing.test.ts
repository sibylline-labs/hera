import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import {
  ActorId,
  Hera,
  HeraAuthedCtx,
  HeraConfig,
  HeraCtx,
  HeraError,
  type HeraMigration,
  type HeraOutboxRecord,
  HeraPublicCtx,
  HeraSchema,
  HeraTenantCtx,
  OrgId,
  RequestId,
} from "../src/index"
import {
  HeraTest,
  makeTestDurableObjectState,
} from "../src/testing/durable-object/index"
import {
  DEFAULT_TEST_TIME_MS,
  HeraTest as HeraTestCore,
  SAMPLE_IDS,
} from "../src/testing/index"

const TEST_MIGRATIONS: ReadonlyArray<HeraMigration> = [
  {
    version: 1,
    name: "create_yaks_table",
    sql: `
      CREATE TABLE yaks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `,
  },
]

interface YakEnv extends Record<string, unknown> {
  readonly YAK_API_SECRET?: string
}

class YakTenantDO extends Hera.TenantDurableObject.configure<YakEnv>({
  service: "yak-tenant-test",
  migrations: TEST_MIGRATIONS,
  outboxBackoff: {
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterRatio: 0,
  },
  alarmErrorBackoffMs: 15_000,
}) {
  static lastDeliveredBatches: Array<ReadonlyArray<HeraOutboxRecord>> = []
  static shouldFailDelivery = false
  static domainAlarmFireCount = 0

  protected override deliverOutboxBatch(
    records: ReadonlyArray<HeraOutboxRecord>
  ): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      if (YakTenantDO.shouldFailDelivery) {
        return Effect.fail(
          new Error("503 Service Unavailable: upstream event bus overloaded")
        )
      }
      YakTenantDO.lastDeliveredBatches.push(records)
      return Effect.void
    })
  }

  protected override onDomainAlarm(
    _nowMs: number
  ): Effect.Effect<number | void, unknown, never> {
    return Effect.sync(() => {
      YakTenantDO.domainAlarmFireCount += 1
    })
  }

  createYakWithEvent(input: {
    readonly id: string
    readonly title: string
  }): Promise<{ readonly id: string; readonly createdAtMs: number }> {
    return this.runWithTenantCtx(
      this.db.transactWithOutbox(function* (tx) {
        const createdAtMs = Date.now()
        yield* tx.exec(
          `INSERT INTO yaks (id, org_id, title, created_at_ms) VALUES (?, ?, ?, ?)`,
          [input.id, SAMPLE_IDS.orgId, input.title, createdAtMs]
        )
        yield* tx.enqueueOutbox({
          id: SAMPLE_IDS.eventId,
          type: "yak.created@1",
          payload: {
            yakId: input.id,
            orgId: SAMPLE_IDS.orgId,
            title: input.title,
          },
        })
        return { id: input.id, createdAtMs }
      })
    )
  }
}

const API_SECRET = ["sib_test", "01234567"].join("_")

describe("HeraTest (@sibylline-labs/hera/testing)", () => {
  describe("HeraTest.layer & deterministic TestClock", () => {
    it("provides HeraPublicCtx, HeraAuthedCtx, HeraTenantCtx, HeraCtx, HeraEnv, TestClock, and seeded SQLite db", async () => {
      const customOrgId = OrgId.make("org_01JAWX9Z8K4M5N6P7Q8R9S0T99")
      const customActorId = ActorId.make("act_01JAWX9Z8K4M5N6P7Q8R9S0T88")
      const customRequestId = RequestId.make("req_01JAWX9Z8K4M5N6P7Q8R9S0T77")
      const capturedLogs: Array<Record<string, unknown>> = []

      const testLayer = HeraTest.layer({
        orgId: customOrgId,
        actorId: customActorId,
        actorKind: "admin",
        scopes: ["yak:read", "yak:write"],
        requestId: customRequestId,
        service: "yak-test-svc",
        initialTimeMs: DEFAULT_TEST_TIME_MS,
        migrations: TEST_MIGRATIONS,
        seedSql: [
          `INSERT INTO yaks (id, org_id, title, created_at_ms) VALUES ('yak-seed-1', '${customOrgId}', 'Seeded Yak', ${DEFAULT_TEST_TIME_MS})`,
        ],
        env: {
          YAK_API_SECRET: `${API_SECRET}\n`,
        },
        sink: (_line, entry) => {
          capturedLogs.push(entry)
        },
      })

      const program = Hera.fn("test.verifyLayer")(function* () {
        const publicCtx = yield* HeraPublicCtx
        const authedCtx = yield* HeraAuthedCtx
        const tenantCtx = yield* HeraTenantCtx
        const legacyCtx = yield* HeraCtx

        expect(publicCtx.requestId).toBe(customRequestId)
        expect(publicCtx.service).toBe("yak-test-svc")
        expect(authedCtx.orgId).toBe(customOrgId)
        expect(authedCtx.actorId).toBe(customActorId)
        expect(authedCtx.actorKind).toBe("admin")
        expect(authedCtx.scopes.has("yak:read")).toBe(true)
        expect(authedCtx.scopes.has("yak:write")).toBe(true)
        expect(tenantCtx.orgId).toBe(customOrgId)
        expect(Option.getOrUndefined(legacyCtx.orgId)).toBe(customOrgId)

        // Verify seeded in-memory DO SQLite database via HeraTenantCtx.db
        const rows = yield* tenantCtx.db.query<{
          readonly id: string
          readonly org_id: string
          readonly title: string
          readonly created_at_ms: number
        }>("SELECT id, org_id, title, created_at_ms FROM yaks WHERE id = ?", [
          "yak-seed-1",
        ])
        expect(rows).toEqual([
          {
            id: "yak-seed-1",
            org_id: customOrgId,
            title: "Seeded Yak",
            created_at_ms: DEFAULT_TEST_TIME_MS,
          },
        ])

        // Verify HeraEnv secret reading with trailing newline stripping
        const secretReader = HeraConfig.secret(
          "YAK_API_SECRET",
          HeraSchema.KeyPrefix
        )
        const secretValue = yield* secretReader
        expect(Redacted.value(secretValue)).toBe(API_SECRET)

        // Verify deterministic TestClock + HeraTest.advanceClock + HeraTest.setClock
        const t0 = yield* Clock.currentTimeMillis
        const ctxNow0 = yield* publicCtx.now
        expect(t0).toBe(DEFAULT_TEST_TIME_MS)
        expect(ctxNow0).toBe(DEFAULT_TEST_TIME_MS)

        const t1 = yield* HeraTest.advanceClock("60 seconds")
        expect(t1).toBe(DEFAULT_TEST_TIME_MS + 60_000)
        expect(yield* Clock.currentTimeMillis).toBe(
          DEFAULT_TEST_TIME_MS + 60_000
        )
        expect(yield* tenantCtx.now).toBe(DEFAULT_TEST_TIME_MS + 60_000)
        expect(yield* HeraTest.currentTimeMillis).toBe(
          DEFAULT_TEST_TIME_MS + 60_000
        )

        const targetTime = DEFAULT_TEST_TIME_MS + 300_000
        const t2 = yield* HeraTest.setClock(targetTime)
        expect(t2).toBe(targetTime)
        expect(yield* Clock.currentTimeMillis).toBe(targetTime)

        yield* tenantCtx.logger.info("layer check complete", {
          seededCount: rows.length,
        })

        return rows.length
      })

      const count = await Effect.runPromise(
        program().pipe(Effect.provide(testLayer))
      )
      expect(count).toBe(1)
      expect(capturedLogs).toHaveLength(1)
      expect(capturedLogs[0]?.org_id).toBe(customOrgId)
      expect(capturedLogs[0]?.actor_id).toBe(customActorId)
      expect(capturedLogs[0]?.request_id).toBe(customRequestId)
    })
  })

  describe("/testing layer without the DO harness", () => {
    it("backs HeraTenantCtx.db with an injected db or a no-op one, and keeps DO members off HeraTest", async () => {
      expect("tenantDoHarness" in HeraTestCore).toBe(false)
      expect("inspectOutbox" in HeraTestCore).toBe(false)
      expect(HeraTest.runTest).toBe(HeraTestCore.runTest)

      const noDbRows = await HeraTestCore.runTest(
        Effect.gen(function* () {
          const tenantCtx = yield* HeraTenantCtx
          return yield* tenantCtx.db.query("SELECT 1")
        }),
        HeraTestCore.layer()
      )
      expect(noDbRows).toEqual([])

      const injectedRows = await HeraTestCore.runTest(
        Effect.gen(function* () {
          const tenantCtx = yield* HeraTenantCtx
          expect(yield* Clock.currentTimeMillis).toBe(DEFAULT_TEST_TIME_MS)
          return yield* tenantCtx.db.query("SELECT id FROM yaks")
        }),
        HeraTestCore.layer({
          db: {
            orgId: SAMPLE_IDS.orgId,
            exec: () => ({ rows: [], rowsRead: 0, rowsWritten: 0 }),
            query: <T,>() => Effect.succeed([{ id: "yak-1" }] as unknown as ReadonlyArray<T>),
          },
        })
      )
      expect(injectedRows).toEqual([{ id: "yak-1" }])
    })
  })

  describe("In-memory DO SQLite, HeraTest.inspectOutbox & HeraTest.triggerAlarm", () => {
    it("supports seedSql in makeTestDurableObjectState and drives outbox retry + backoff deterministically via HeraTest.inspectOutbox and HeraTest.triggerAlarm", async () => {
      YakTenantDO.lastDeliveredBatches = []
      YakTenantDO.shouldFailDelivery = true
      YakTenantDO.domainAlarmFireCount = 0

      const harness = HeraTest.tenantDoHarness(YakTenantDO, {
        orgId: SAMPLE_IDS.orgId,
        initialTimeMs: DEFAULT_TEST_TIME_MS,
        seedSql: `INSERT INTO yaks (id, org_id, title, created_at_ms) VALUES ('yak-000', '${SAMPLE_IDS.orgId}', 'Pre-seeded Yak', ${DEFAULT_TEST_TIME_MS - 5_000})`,
      })

      // Verify pre-seeded row exists alongside newly transacted row + outbox event
      const created = await harness.instance.createYakWithEvent({
        id: "yak-001",
        title: "Outbox Test Yak",
      })
      expect(created.id).toBe("yak-001")

      const allYaks = await Effect.runPromise(
        harness.instance.db.query<{ readonly id: string }>(
          "SELECT id FROM yaks ORDER BY id ASC"
        )
      )
      expect(allYaks.map((r) => r.id)).toEqual(["yak-000", "yak-001"])

      // Inspect outbox via both standalone HeraTest.inspectOutbox() and harness.inspectOutbox()
      const pendingInitial = HeraTest.inspectOutbox()
      expect(pendingInitial).toHaveLength(1)
      expect(pendingInitial[0]?.id).toBe(SAMPLE_IDS.eventId)
      expect(pendingInitial[0]?.type).toBe("yak.created@1")
      expect(pendingInitial[0]?.attempts).toBe(0)
      expect(pendingInitial[0]?.nextAttemptAt).toBe(DEFAULT_TEST_TIME_MS)

      // Schedule a domain alarm 5 seconds in the future as well
      await Effect.runPromise(
        harness.instance.scheduleDomainAlarm(DEFAULT_TEST_TIME_MS + 5_000)
      )

      // 1. Trigger alarm while upstream delivery fails (503 Service Unavailable)
      await HeraTest.triggerAlarm()
      const afterFailedAttempt = HeraTest.inspectOutbox(harness)
      expect(afterFailedAttempt).toHaveLength(1)
      expect(afterFailedAttempt[0]?.attempts).toBe(1)
      expect(afterFailedAttempt[0]?.lastError).toContain(
        "503 Service Unavailable"
      )
      // Backoff advances nextAttemptAt by baseDelayMs (1000ms)
      expect(afterFailedAttempt[0]?.nextAttemptAt).toBe(
        DEFAULT_TEST_TIME_MS + 1_000
      )
      // Domain alarm at +5000ms should not have fired yet
      expect(YakTenantDO.domainAlarmFireCount).toBe(0)

      // 2. Restore upstream delivery and advance clock by 60 seconds via HeraTest.triggerAlarm
      YakTenantDO.shouldFailDelivery = false
      await HeraTest.triggerAlarm(harness, "60 seconds")

      // Outbox should now be completely drained and domain alarm should have fired
      expect(HeraTest.inspectOutbox(harness)).toEqual([])
      expect(YakTenantDO.lastDeliveredBatches).toHaveLength(1)
      expect(YakTenantDO.lastDeliveredBatches[0]?.[0]?.id).toBe(
        SAMPLE_IDS.eventId
      )
      expect(YakTenantDO.domainAlarmFireCount).toBe(1)
    })

    it("supports makeTestDurableObjectState directly with seedSql and initialTimeMs", async () => {
      const doHarness = makeTestDurableObjectState({
        orgId: SAMPLE_IDS.orgId,
        initialTimeMs: DEFAULT_TEST_TIME_MS + 10_000,
        seedSql: [
          `INSERT INTO yaks (id, org_id, title, created_at_ms) VALUES ('yak-direct', '${SAMPLE_IDS.orgId}', 'Direct State Seed', ${DEFAULT_TEST_TIME_MS})`,
        ],
      })
      const instance = new YakTenantDO(doHarness.state, {})
      const rows = await Effect.runPromise(
        instance.db.query<{ readonly id: string; readonly title: string }>(
          "SELECT id, title FROM yaks"
        )
      )
      expect(rows).toEqual([
        { id: "yak-direct", title: "Direct State Seed" },
      ])
    })
  })

  describe("HeraTest.rpcDouble conformance & fault injection", () => {
    it("supports happy-path RPC calls, call recording, .unreachable, .rateLimited(retryAfter), .defectOnNextCall(error) with secret scrubbing, and .resetFaults()", async () => {
      const accountsDouble = HeraTest.rpcDouble("accounts", {
        verifyKey: (input: { readonly keyPrefix: string }) =>
          Effect.succeed({
            orgId: SAMPLE_IDS.orgId,
            actorId: SAMPLE_IDS.actorId,
            keyPrefix: input.keyPrefix,
          }),
        ping: async () => ({ status: "ok" as const }),
      })

      // 1. Happy path via pre-bound .client
      const verified = await Effect.runPromise(
        accountsDouble.client.verifyKey({
          keyPrefix: SAMPLE_IDS.keyPrefix,
        })
      )
      expect(verified).toEqual({
        orgId: SAMPLE_IDS.orgId,
        actorId: SAMPLE_IDS.actorId,
        keyPrefix: SAMPLE_IDS.keyPrefix,
      })
      expect(accountsDouble.calls).toHaveLength(1)
      expect(accountsDouble.calls[0]?.method).toBe("verifyKey")
      expect(accountsDouble.calls[0]?.input).toEqual({
        keyPrefix: SAMPLE_IDS.keyPrefix,
      })

      // 2. .unreachable = true fault injection (envelope mode) -> 503 accounts_unavailable
      accountsDouble.unreachable = true
      const unreachableExit = await Effect.runPromiseExit(
        accountsDouble.client.verifyKey({
          keyPrefix: SAMPLE_IDS.keyPrefix,
        })
      )
      expect(Exit.isFailure(unreachableExit)).toBe(true)
      if (Exit.isFailure(unreachableExit)) {
        const err = Option.getOrThrow(
          Effect.runSync(
            Effect.succeed(unreachableExit.cause).pipe(
              Effect.map((c) =>
                c.reasons[0]?._tag === "Fail"
                  ? Option.some(c.reasons[0].error)
                  : Option.none()
              )
            )
          )
        )
        expect(HeraError.is(err)).toBe(true)
        expect(err.code).toBe("accounts_unavailable")
        expect(err.httpStatus).toBe(503)
      }

      // 3. .setUnreachable(true, { mode: "transport" }) -> transport rejection mapped to 503 accounts_unavailable
      accountsDouble.setUnreachable(true, { mode: "transport" })
      const transportErr = await Effect.runPromise(
        Effect.flip(
          accountsDouble.client.verifyKey({
            keyPrefix: SAMPLE_IDS.keyPrefix,
          })
        )
      )
      expect(transportErr.code).toBe("accounts_unavailable")
      expect(transportErr.httpStatus).toBe(503)
      accountsDouble.unreachable = false

      // 4. .rateLimited(45) fault injection -> 429 rate_limited with retryAfter: 45
      accountsDouble.rateLimited(45)
      const rateLimitErr = await Effect.runPromise(
        Effect.flip(
          accountsDouble.client.verifyKey({
            keyPrefix: SAMPLE_IDS.keyPrefix,
          })
        )
      )
      expect(rateLimitErr.code).toBe("rate_limited")
      expect(rateLimitErr.httpStatus).toBe(429)
      expect(rateLimitErr.fields?.retryAfter).toBe(45)
      expect(rateLimitErr.fields?.retryAfterSeconds).toBe(45)
      accountsDouble.clearRateLimit()

      // 5. .defectOnNextCall(error) -> one-shot 503 accounts_unavailable with zero secret leakage
      const leakedSecret =
        "postgres://admin:super_secret_password_999@db.internal:5432/prod"
      accountsDouble.defectOnNextCall(
        new Error(`FATAL DB connection failure: ${leakedSecret}`)
      )

      const defectErr = await Effect.runPromise(
        Effect.flip(
          accountsDouble.client.verifyKey({
            keyPrefix: SAMPLE_IDS.keyPrefix,
          })
        )
      )
      expect(defectErr.code).toBe("accounts_unavailable")
      expect(defectErr.httpStatus).toBe(503)
      expect(defectErr.publicMessage).toBe("Accounts service unavailable")
      expect(JSON.stringify(defectErr)).not.toContain(
        "super_secret_password_999"
      )
      expect(defectErr.message).not.toContain("super_secret_password_999")

      // Next call after one-shot defect succeeds normally
      const recovered = await Effect.runPromise(accountsDouble.client.ping())
      expect(recovered).toEqual({ status: "ok" })

      // 6. .resetFaults() clears all toggles and call history
      accountsDouble.unreachable = true
      accountsDouble.rateLimited(10)
      accountsDouble.defectOnNextCall(new Error("boom"))
      accountsDouble.resetFaults()

      expect(accountsDouble.unreachable).toBe(false)
      expect(accountsDouble.calls).toHaveLength(0)
      const afterReset = await Effect.runPromise(accountsDouble.client.ping())
      expect(afterReset).toEqual({ status: "ok" })
      expect(accountsDouble.calls).toHaveLength(1)
    })
  })
})
