import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import {
  ActorId,
  Hera,
  HeraAuthedCtx,
  HeraPublicCtx,
  HeraTenantCtx,
  type LogEntry,
  OrgId,
  RequestId,
} from "../src/index"

const ULID_BASE = "01JAW4B8X7H2M9Q5R8T3V6Y1Z0"
const ULID_FIBER_A = "01JAW4B8X7H2M9Q5R8T3V6Y1ZA"
const ULID_FIBER_B = "01JAW4B8X7H2M9Q5R8T3V6Y1ZB"

describe("HeraAmbientCtx & Capability Gates", () => {
  const sampleIds = {
    requestId: RequestId.make(`req_${ULID_BASE}`),
    orgId: OrgId.make(`org_${ULID_BASE}`),
    actorId: ActorId.make(`act_${ULID_BASE}`),
  }

  it("enforces compile-time capability gates on Hera.publicRoute, Hera.authedRoute, and Hera.tenantRoute", () => {
    const publicEffect = Effect.gen(function* () {
      const ctx = yield* HeraPublicCtx
      return ctx.requestId
    })

    const authedEffect = Effect.gen(function* () {
      const ctx = yield* HeraAuthedCtx
      return `${ctx.orgId}:${ctx.actorId}`
    })

    const tenantEffect = Effect.gen(function* () {
      const ctx = yield* HeraTenantCtx
      return ctx.orgId
    })

    // Valid capability registrations:
    const validPublic = Hera.publicRoute(publicEffect)
    const validPublicFn = Hera.publicRoute(() => publicEffect)
    const validAuthedFromPublic = Hera.authedRoute(publicEffect)
    const validAuthed = Hera.authedRoute(authedEffect)
    const validAuthedFn = Hera.authedRoute(() => authedEffect)
    const validTenant = Hera.tenantRoute(tenantEffect)
    const validTenantFn = Hera.tenantRoute(() => tenantEffect)

    expect(validPublic).toBe(publicEffect)
    expect(typeof validPublicFn).toBe("function")
    expect(validAuthedFromPublic).toBe(publicEffect)
    expect(validAuthed).toBe(authedEffect)
    expect(typeof validAuthedFn).toBe("function")
    expect(validTenant).toBe(tenantEffect)
    expect(typeof validTenantFn).toBe("function")

    // Invalid capability registrations rejected at compile time:
    // @ts-expect-error HeraAuthedCtx effect cannot be passed to Hera.publicRoute
    Hera.publicRoute(authedEffect)

    // @ts-expect-error HeraAuthedCtx handler function cannot be passed to Hera.publicRoute
    Hera.publicRoute(() => authedEffect)

    // @ts-expect-error HeraTenantCtx effect cannot be passed to Hera.publicRoute
    Hera.publicRoute(tenantEffect)

    // @ts-expect-error HeraTenantCtx handler function cannot be passed to Hera.publicRoute
    Hera.publicRoute(() => tenantEffect)

    // @ts-expect-error HeraTenantCtx effect cannot be passed to Hera.authedRoute
    Hera.authedRoute(tenantEffect)

    // @ts-expect-error HeraAuthedCtx effect cannot be passed to Hera.tenantRoute
    Hera.tenantRoute(authedEffect)
  })

  it("populates HeraPublicCtx, HeraAuthedCtx, and HeraTenantCtx layers with pre-bound correlation loggers", async () => {
    const publicLogs: Array<LogEntry> = []
    const authedLogs: Array<LogEntry> = []
    const tenantLogs: Array<LogEntry> = []
    const scheduledAlarms: Array<number> = []

    // 1. HeraPublicCtx
    const publicProgram = Effect.gen(function* () {
      const pub = yield* HeraPublicCtx
      yield* pub.logger.info("healthz check")
      return `${pub.service}:${pub.requestId}`
    }).pipe(
      Effect.provide(
        HeraPublicCtx.layer({
          requestId: sampleIds.requestId,
          service: "hera-public",
          sink: (_line, entry) => publicLogs.push(entry),
        })
      )
    )

    expect(await Effect.runPromise(publicProgram)).toBe(
      `hera-public:${sampleIds.requestId}`
    )
    expect(publicLogs[0]).toMatchObject({
      service: "hera-public",
      msg: "healthz check",
      request_id: sampleIds.requestId,
      org_id: null,
      actor_id: null,
    })

    // 2. HeraAuthedCtx (also satisfies HeraPublicCtx in the same scope)
    const authedProgram = Effect.gen(function* () {
      const authed = yield* HeraAuthedCtx
      const pub = yield* HeraPublicCtx
      yield* authed.logger.info("authed mutation", { action: "create_item" })
      return {
        orgId: authed.orgId,
        actorId: authed.actorId,
        actorKind: authed.actorKind,
        hasWriteScope: authed.scopes.has("yak:write"),
        productPlan: authed.productCtx.plan,
        sameRequestId: pub.requestId === authed.requestId,
      }
    }).pipe(
      Effect.provide(
        HeraAuthedCtx.layer({
          requestId: sampleIds.requestId,
          service: "hera-api",
          orgId: sampleIds.orgId,
          actorId: sampleIds.actorId,
          actorKind: "service_key",
          scopes: ["yak:read", "yak:write"],
          productCtx: { plan: "enterprise" },
          sink: (_line, entry) => authedLogs.push(entry),
        })
      )
    )

    expect(await Effect.runPromise(authedProgram)).toEqual({
      orgId: sampleIds.orgId,
      actorId: sampleIds.actorId,
      actorKind: "service_key",
      hasWriteScope: true,
      productPlan: "enterprise",
      sameRequestId: true,
    })
    expect(authedLogs[0]).toMatchObject({
      service: "hera-api",
      msg: "authed mutation",
      request_id: sampleIds.requestId,
      org_id: sampleIds.orgId,
      actor_id: sampleIds.actorId,
      action: "create_item",
    })

    // 3. HeraTenantCtx (pre-bound DO logger + db + scheduleDomainAlarm)
    const tenantProgram = Effect.gen(function* () {
      const tenant = yield* HeraTenantCtx
      yield* tenant.logger.info("running tenant compaction")
      yield* tenant.scheduleDomainAlarm(1_750_000_000_000)
      return {
        orgId: tenant.orgId,
        dbOrgId: tenant.db.orgId,
      }
    }).pipe(
      Effect.provide(
        HeraTenantCtx.layer({
          orgId: sampleIds.orgId,
          service: "hera-do",
          requestId: sampleIds.requestId,
          actorId: sampleIds.actorId,
          scheduleDomainAlarm: (atMs) =>
            Effect.sync(() => {
              scheduledAlarms.push(atMs)
            }),
          sink: (_line, entry) => tenantLogs.push(entry),
        })
      )
    )

    expect(await Effect.runPromise(tenantProgram)).toEqual({
      orgId: sampleIds.orgId,
      dbOrgId: sampleIds.orgId,
    })
    expect(scheduledAlarms).toEqual([1_750_000_000_000])
    expect(tenantLogs[0]).toMatchObject({
      service: "hera-do",
      msg: "running tenant compaction",
      request_id: sampleIds.requestId,
      org_id: sampleIds.orgId,
      actor_id: sampleIds.actorId,
    })
  })

  it("isolates concurrent fiber contexts and child logger correlation layers without cross-fiber bleed", async () => {
    const entries: Array<LogEntry> = []
    const orgA = OrgId.make(`org_${ULID_FIBER_A}`)
    const orgB = OrgId.make(`org_${ULID_FIBER_B}`)
    const reqA = RequestId.make(`req_${ULID_FIBER_A}`)
    const reqB = RequestId.make(`req_${ULID_FIBER_B}`)
    const actorA = ActorId.make(`act_${ULID_FIBER_A}`)
    const actorB = ActorId.make(`act_${ULID_FIBER_B}`)

    const workerTask = (jobId: string) =>
      Effect.gen(function* () {
        const ctx = yield* HeraAuthedCtx
        const child = ctx.logger.child({ jobId })
        yield* Effect.gen(function* () {
          const innerCtx = yield* HeraAuthedCtx
          yield* innerCtx.logger.info("fiber step", { workerJob: jobId })
        }).pipe(Effect.provide(child.layer))
        return `${ctx.orgId}:${jobId}`
      })

    const concurrentProgram = Effect.gen(function* () {
      const fiberA = yield* Effect.forkChild(
        workerTask("job_alpha").pipe(
          Effect.provide(
            HeraAuthedCtx.layer({
              requestId: reqA,
              orgId: orgA,
              actorId: actorA,
              service: "hera-concurrent",
              sink: (_line, entry) => entries.push(entry),
            })
          )
        )
      )
      const fiberB = yield* Effect.forkChild(
        workerTask("job_beta").pipe(
          Effect.provide(
            HeraAuthedCtx.layer({
              requestId: reqB,
              orgId: orgB,
              actorId: actorB,
              service: "hera-concurrent",
              sink: (_line, entry) => entries.push(entry),
            })
          )
        )
      )

      return yield* Effect.all([Fiber.join(fiberA), Fiber.join(fiberB)])
    })

    const [resA, resB] = await Effect.runPromise(concurrentProgram)
    expect(resA).toBe(`${orgA}:job_alpha`)
    expect(resB).toBe(`${orgB}:job_beta`)

    const logA = entries.find((e) => e.org_id === orgA)
    const logB = entries.find((e) => e.org_id === orgB)

    expect(logA).toMatchObject({
      org_id: orgA,
      request_id: reqA,
      actor_id: actorA,
      jobId: "job_alpha",
      workerJob: "job_alpha",
    })
    expect(logB).toMatchObject({
      org_id: orgB,
      request_id: reqB,
      actor_id: actorB,
      jobId: "job_beta",
      workerJob: "job_beta",
    })
  })

  it("reads deterministic time from Effect TestClock via ctx.now and logger timestamp without Date.now()", async () => {
    const entries: Array<LogEntry> = []
    const baseEpochMs = 1_760_000_000_000

    const program = Effect.gen(function* () {
      yield* TestClock.setTime(baseEpochMs)
      const ctx = yield* HeraAuthedCtx
      const t0 = yield* ctx.now
      yield* ctx.logger.info("at t0")

      yield* TestClock.adjust("45 seconds")
      const t1 = yield* ctx.now
      yield* ctx.logger.info("at t1")

      return [t0, t1] as const
    }).pipe(
      Effect.provide(
        HeraAuthedCtx.layer({
          requestId: sampleIds.requestId,
          service: "hera-clock-test",
          orgId: sampleIds.orgId,
          actorId: sampleIds.actorId,
          sink: (_line, entry) => entries.push(entry),
        })
      ),
      Effect.provide(TestClock.layer())
    )

    const [t0, t1] = await Effect.runPromise(program)
    expect(t0).toBe(baseEpochMs)
    expect(t1).toBe(baseEpochMs + 45_000)
    expect(entries[0]?.timestamp).toBe(new Date(baseEpochMs).toISOString())
    expect(entries[1]?.timestamp).toBe(new Date(baseEpochMs + 45_000).toISOString())
  })
})
