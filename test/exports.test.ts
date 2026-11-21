import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as AuthoritySubpath from "../src/core/authority/index"
import * as CoreBarrel from "../src/core/index"
import * as ObjectStoreSubpath from "../src/core/object-store/index"
import * as OpenApiSubpath from "../src/core/openapi/index"
import * as CliBarrel from "../src/cli/index"
import * as RootBarrel from "../src/index"
import * as DurableObjectSubpath from "../src/server/durable-object/index"
import {
  AtomicPairWriter,
  DirLock,
  ErisError,
  HeraCli,
  renderFailureBlock,
  Runner,
  scrubFreeText,
} from "../src/cli/index"
import {
  AccountId,
  ActorId,
  authedRoute,
  ClusterId,
  DeliveryId,
  EventId,
  Hera,
  HeraConfig,
  HeraCtx,
  HeraError,
  HeraHttp,
  HeraHttpError,
  HeraOAuth2,
  HeraOAuth2Error,
  HeraCache,
  HeraObjectStore,
  HeraOpenApi,
  HeraSchema,
  HeraTenantCtx,
  HeraWebhook,
  KeyHash,
  KeyPrefix,
  LinearIdentifier,
  MemberId,
  OrgId,
  orgDoName,
  parseOrgDoName,
  parseRetryAfter,
  prefixRouter,
  publicRoute,
  RateLimitedError,
  RequestId,
  router,
  rpcClient,
  rpcMethod,
  SubscriptionId,
  TenantDurableObject,
  Ulid,
  YakId,
} from "../src/index"
import {
  HeraTest,
  makeTestCtx,
  makeTestHexKey,
  makeTestKeyring,
  makeTestTenantCtx,
  SAMPLE_IDS,
  withTestCtx,
  withTestEnv,
  withTestTenantCtx,
  makeTestObjectStore,
  makeTestAuthority,
} from "../src/testing/index"
import {
  HeraWebhook as RoutesHeraWebhook,
  resolveRequestId as routesResolveRequestId,
} from "../src/server/routes/index"
import { resolveRequestId } from "../src/index"

describe("@sibylline-labs/hera entrypoint exports", () => {
  // admits: a barrel or subpath dropping a public export, or leaking one that must stay internal
  // (the authority ctx constructor); module graphs are not type-checked for absence.
  it("exports primary runtime namespaces and foundational classes", () => {
    expect(Hera).toBeDefined()
    expect(typeof Hera.fn).toBe("function")
    expect(Hera.decode).toBe(HeraSchema.decode)
    expect(Hera.secret).toBe(HeraConfig.secret)
    expect(Hera.hexKey).toBe(HeraConfig.hexKey)
    expect(Hera.keyring).toBe(HeraConfig.keyring)
    expect(Hera.publicRoute).toBe(publicRoute)
    expect(Hera.authedRoute).toBe(authedRoute)
    expect(Hera.router).toBe(router)
    expect(Hera.prefixRouter).toBe(prefixRouter)
    expect(typeof HeraWebhook.verifyHmac).toBe("function")
    expect(typeof HeraWebhook.refusalReason).toBe("function")
    expect(typeof HeraWebhook.stripe).toBe("function")
    expect(RoutesHeraWebhook).toBe(HeraWebhook)
    expect(typeof resolveRequestId).toBe("function")
    expect(routesResolveRequestId).toBe(resolveRequestId)
    expect(Hera.rpcMethod).toBe(rpcMethod)
    expect(Hera.rpcClient).toBe(rpcClient)
    expect(Hera.TenantDurableObject).toBe(TenantDurableObject)
    expect(typeof Hera.getTenantStub).toBe("function")
    expect(Hera.SyncTx).toBeDefined()
    expect(typeof RootBarrel.HeraStateMachine.define).toBe("function")
    expect(DurableObjectSubpath.HeraStateMachine).toBe(RootBarrel.HeraStateMachine)
    expect(DurableObjectSubpath.HeraStateMachineError).toBe(RootBarrel.HeraStateMachineError)

    expect(HeraSchema).toBeDefined()
    expect(HeraConfig).toBeDefined()
    expect(HeraCtx).toBeDefined()
    expect(HeraTenantCtx).toBeDefined()
    expect(HeraError).toBeDefined()
    expect(TenantDurableObject).toBeDefined()
    expect(HeraCli).toBeDefined()
    expect(typeof HeraCli.verb).toBe("function")
    expect(typeof HeraCli.forEachBounded).toBe("function")
    expect(ErisError).toBeDefined()
    expect(Runner).toBeDefined()
    expect(AtomicPairWriter).toBeDefined()
    expect(typeof HeraCli.writeFileAtomic).toBe("function")
    expect(typeof HeraCli.writePair).toBe("function")
    expect(typeof HeraCli.stagePair).toBe("function")
    expect(DirLock).toBeDefined()
    expect(typeof scrubFreeText).toBe("function")
    expect(typeof renderFailureBlock).toBe("function")
    expect(HeraHttp).toBeDefined()
    expect(typeof HeraHttp.request).toBe("function")
    expect(typeof HeraHttp.graphql).toBe("function")
    expect(typeof HeraHttp.raw).toBe("function")
    expect(typeof HeraOAuth2.client).toBe("function")
    expect(HeraOAuth2.HeraOAuth2Error).toBe(HeraOAuth2Error)
    expect(typeof parseRetryAfter).toBe("function")
    expect(RateLimitedError).toBeDefined()
    expect(HeraHttpError).toBeDefined()
    expect(HeraObjectStore).toBe(ObjectStoreSubpath.HeraObjectStore)
    expect(typeof HeraObjectStore.r2S3).toBe("function")
    expect(typeof HeraObjectStore.credentialsFromApiToken).toBe("function")
    expect(CoreBarrel.HeraObjectStore).toBe(HeraObjectStore)
    expect(HeraOpenApi).toBe(OpenApiSubpath.HeraOpenApi)
    expect(CoreBarrel.HeraOpenApi).toBe(HeraOpenApi)
    expect(typeof HeraOpenApi.document).toBe("function")
    expect(typeof HeraCache.make).toBe("function")
    expect(CoreBarrel.HeraCache).toBe(HeraCache)
    expect(CoreBarrel.HeraAuthorityVerifier).toBe(AuthoritySubpath.HeraAuthorityVerifier)
    expect(CliBarrel.HeraAuthorityVerifier).toBe(AuthoritySubpath.HeraAuthorityVerifier)
    expect(RootBarrel.HeraAuthorityRefusal).toBe(AuthoritySubpath.HeraAuthorityRefusal)
    expect(typeof AuthoritySubpath.refuseAuthority).toBe("function")
    // The ctx constructor is boundary-internal: no barrel or subpath mints a granted ctx.
    for (const barrel of [AuthoritySubpath, CoreBarrel, CliBarrel, RootBarrel]) {
      expect("grantAuthorityCtx" in barrel).toBe(false)
    }
    // Product wire contracts live in their products' packages, never in the framework.
    expect(Object.keys(CoreBarrel).filter((k) => k.endsWith("_OPENAPI_OPERATIONS"))).toEqual([])
    expect("YakSubmissionSchema" in CoreBarrel).toBe(false)
  })

  it("exports all 12+ canonical branded ID schemas at top level and on HeraSchema", () => {
    const schemas = [
      ["OrgId", OrgId, HeraSchema.OrgId, SAMPLE_IDS.orgId],
      ["ActorId", ActorId, HeraSchema.ActorId, SAMPLE_IDS.actorId],
      ["RequestId", RequestId, HeraSchema.RequestId, SAMPLE_IDS.requestId],
      ["KeyHash", KeyHash, HeraSchema.KeyHash, SAMPLE_IDS.keyHash],
      ["KeyPrefix", KeyPrefix, HeraSchema.KeyPrefix, SAMPLE_IDS.keyPrefix],
      ["EventId", EventId, HeraSchema.EventId, SAMPLE_IDS.eventId],
      ["DeliveryId", DeliveryId, HeraSchema.DeliveryId, SAMPLE_IDS.deliveryId],
      [
        "SubscriptionId",
        SubscriptionId,
        HeraSchema.SubscriptionId,
        SAMPLE_IDS.subscriptionId,
      ],
      ["AccountId", AccountId, HeraSchema.AccountId, SAMPLE_IDS.accountId],
      ["YakId", YakId, HeraSchema.YakId, SAMPLE_IDS.yakId],
      ["ClusterId", ClusterId, HeraSchema.ClusterId, SAMPLE_IDS.clusterId],
      [
        "LinearIdentifier",
        LinearIdentifier,
        HeraSchema.LinearIdentifier,
        SAMPLE_IDS.linearIdentifier,
      ],
      ["MemberId", MemberId, HeraSchema.MemberId, SAMPLE_IDS.memberId],
      ["Ulid", Ulid, HeraSchema.Ulid, SAMPLE_IDS.ulid],
    ] as const

    for (const [name, topLevel, onNamespace, sample] of schemas) {
      expect(topLevel, `${name} top-level export`).toBe(onNamespace)
      expect(topLevel.is(sample), `${name}.is(sample)`).toBe(true)
      expect(topLevel.make(sample), `${name}.make(sample)`).toBe(sample)
    }
  })
})

describe("@sibylline-labs/hera/testing entrypoint exports", () => {
  // admits: a HeraTest member that drifts from the builder it aliases; identity is a runtime fact.
  it("exports HeraTest namespace and deterministic fixture builders", () => {
    expect(HeraTest.SAMPLE_IDS).toBe(SAMPLE_IDS)
    expect(HeraTest.makeTestCtx).toBe(makeTestCtx)
    expect(HeraTest.makeTestTenantCtx).toBe(makeTestTenantCtx)
    expect(HeraTest.makeTestHexKey).toBe(makeTestHexKey)
    expect(HeraTest.makeTestKeyring).toBe(makeTestKeyring)
    expect(HeraTest.withTestCtx).toBe(withTestCtx)
    expect(HeraTest.withTestTenantCtx).toBe(withTestTenantCtx)
    expect(HeraTest.withTestEnv).toBe(withTestEnv)
    expect(HeraTest.objectStore).toBe(makeTestObjectStore)
    expect(HeraTest.authority).toBe(makeTestAuthority)
  })

  it("provides valid hex keys and keyrings via makeTestHexKey and makeTestKeyring", () => {
    const hex32 = makeTestHexKey(32, 0xcd)
    expect(hex32).toHaveLength(64)
    const keyStatus = HeraConfig.hexKey({ ENC_KEY: hex32 }, "ENC_KEY", 32)
    expect(HeraConfig.isValid(keyStatus)).toBe(true)
    if (HeraConfig.isValid(keyStatus)) {
      expect(Redacted.value(keyStatus.value)).toBeInstanceOf(Uint8Array)
      expect(Redacted.value(keyStatus.value).byteLength).toBe(32)
    }

    const rawRing = makeTestKeyring([1, 2], 32)
    const ringStatus = HeraConfig.keyring({ KEYRING: rawRing }, "KEYRING")
    expect(HeraConfig.isValid(ringStatus)).toBe(true)
    if (HeraConfig.isValid(ringStatus)) {
      const ring = Redacted.value(ringStatus.value)
      expect(ring.activeVersion).toBe("v2")
      expect(ring.versions).toEqual(["v1", "v2"])
    }
  })
})

describe("cross-module integration (HeraSchema, HeraConfig, HeraError, HeraCtx, Hera.fn, TenantDurableObject)", () => {
  it("maps HeraSchemaError to 400 HeraError without leaking rejected input values", async () => {
    const Payload = Schema.Struct({
      orgId: OrgId,
    })
    const sensitiveInput = "super-secret-bad-org-id-99999"

    const program = Hera.decode(Payload, { orgId: sensitiveInput }).pipe(
      Effect.mapError((err) => HeraError.fromSchemaError(err))
    )

    const exit = await Effect.runPromiseExit(program)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const serialized = JSON.stringify(exit.cause)
      expect(serialized).not.toContain(sensitiveInput)
    }

    const result = HeraSchema.decodeResult(Payload, { orgId: sensitiveInput })
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const heraErr = HeraError.fromSchemaError(result.failure)
      expect(heraErr.httpStatus).toBe(400)
      expect(heraErr.status).toBe(400)
      expect(heraErr.code).toBe("invalid_request")
      const problem = heraErr.toProblemDetails()
      expect(problem.status).toBe(400)
      expect(problem.code).toBe("invalid_request")
      expect(problem.issues?.length).toBeGreaterThan(0)
      expect(JSON.stringify(problem)).not.toContain(sensitiveInput)
      expect(JSON.stringify(heraErr)).not.toContain(sensitiveInput)
    }
  })

  it("maps HeraConfigError to 503 HeraError without leaking invalid secret values", async () => {
    const reader = HeraConfig.hexKey(" SIGNING_KEY ".trim(), 32)

    const unconfiguredExit = await Effect.runPromiseExit(
      reader.effect({ SIGNING_KEY: "\n" }).pipe(
        Effect.mapError((err) => HeraError.fromConfigError(err))
      )
    )
    expect(unconfiguredExit._tag).toBe("Failure")

    const leakedCandidate = "not-a-valid-hex-secret-value-xyz-12345"
    const invalidProgram = Effect.flip(
      reader.effect({ SIGNING_KEY: leakedCandidate })
    ).pipe(Effect.map((cfgErr) => HeraError.fromConfigError(cfgErr)))
    const heraErr = await Effect.runPromise(invalidProgram)
    expect(heraErr.httpStatus).toBe(503)
    expect(heraErr.code).toBe("signing_key_invalid_config")
    expect(JSON.stringify(heraErr.toProblemDetails())).not.toContain(
      leakedCandidate
    )
  })

  it("provides HeraCtx and HeraTenantCtx layers and traces functions via Hera.fn", async () => {
    const readTenantSummary = Hera.fn("TenantService.summary")(function* (
      prefix: string
    ) {
      const tenant = yield* HeraTenantCtx
      const baseCtx = yield* HeraCtx
      return `${prefix}:${tenant.service}:${tenant.orgId}:${Option.getOrThrow(baseCtx.orgId)}`
    })

    const output = await Effect.runPromise(
      withTestTenantCtx(readTenantSummary("ok"), {
        service: "polaris-gateway",
      })
    )
    expect(output).toBe(
      `ok:polaris-gateway:${SAMPLE_IDS.orgId}:${SAMPLE_IDS.orgId}`
    )

    const directFn = Hera.fn("Direct.op", (x: number) =>
      Effect.map(HeraCtx, (ctx) => `${ctx.service}:${x}`)
    )
    const directOut = await Effect.runPromise(
      directFn(42).pipe(withTestCtx({ service: "hera-unit" }))
    )
    expect(directOut).toBe("hera-unit:42")
  })

  it("formats and parses TenantDurableObject names with OrgId validation", () => {
    const doName = orgDoName(SAMPLE_IDS.orgId)
    expect(doName).toBe(`org:${SAMPLE_IDS.orgId}`)
    expect(TenantDurableObject.orgDoName(SAMPLE_IDS.orgId)).toBe(doName)

    const parsed = parseOrgDoName(doName)
    expect(Option.isSome(parsed)).toBe(true)
    expect(Option.getOrNull(parsed)).toBe(SAMPLE_IDS.orgId)

    expect(Option.isNone(parseOrgDoName("user:123"))).toBe(true)
    expect(Option.isNone(parseOrgDoName("org:not-a-ulid"))).toBe(true)
  })

  it("supports all HeraError catalog factory constructors", () => {
    const cases = [
      [HeraError.badRequest("bad"), 400, "bad_request"],
      [HeraError.unauthorized("unauth"), 401, "unauthorized"],
      [HeraError.forbidden("forbid"), 403, "forbidden"],
      [HeraError.notFound("missing"), 404, "not_found"],
      [HeraError.conflict("dup"), 409, "conflict"],
      [HeraError.unprocessable("unproc"), 422, "unprocessable_entity"],
      [HeraError.rateLimited("slow"), 429, "rate_limited"],
      [HeraError.internal("boom", { cause: new Error("db secret") }), 500, "internal_error"],
      [HeraError.badGateway("upstream"), 502, "bad_gateway"],
      [HeraError.serviceUnavailable("down"), 503, "service_unavailable"],
    ] as const

    for (const [err, expectedStatus, expectedCode] of cases) {
      expect(HeraError.is(err)).toBe(true)
      expect(err.httpStatus).toBe(expectedStatus)
      expect(err.code).toBe(expectedCode)
      const problem = err.toProblemDetails()
      expect(problem.status).toBe(expectedStatus)
      expect(problem.code).toBe(expectedCode)
      expect(JSON.stringify(problem)).not.toContain("db secret")
    }
  })
})
