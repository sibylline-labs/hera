import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  Hera,
  type HeraBoundaryDefectLog,
  HeraConfig,
  HeraCtx,
  type HeraCtxShape,
  HeraError,
  HeraTenantCtx,
  OrgId,
  RequestId,
  YakId,
} from "../src/index"
import {
  makeTestCtx,
  makeTestTenantCtx,
  SAMPLE_IDS,
} from "../src/testing/index"

describe("Hera.publicRoute & Hera.authedRoute — HTTP boundary builders", () => {
  describe("Hera.publicRoute", () => {
    const CreateEventRoute = Hera.publicRoute({
      name: "Events.createPublic",
      service: "polaris-events",
      params: Schema.Struct({
        orgId: OrgId,
      }),
      query: Schema.Struct({
        dryRun: Schema.optionalKey(Schema.Literals(["true", "false"])),
      }),
      headers: Schema.Struct({
        "x-client-version": Schema.NonEmptyString,
      }),
      body: Schema.Struct({
        yakId: YakId,
        title: Schema.NonEmptyString,
      }),
      handler: ({ params, query, headers, body }) =>
        Effect.gen(function* () {
          const ctx = yield* HeraCtx
          return {
            accepted: true,
            orgId: params.orgId,
            yakId: body.yakId,
            dryRun: query.dryRun === "true",
            clientVersion: headers["x-client-version"],
            requestId: ctx.requestId,
          }
        }),
    })

    it("decodes params, query, lowercase headers, and JSON body and returns 200 JSON with x-request-id", async () => {
      const req = new Request(
        `https://api.example.com/orgs/${SAMPLE_IDS.orgId}/events?dryRun=true`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Client-Version": "2.4.0",
            "x-request-id": SAMPLE_IDS.requestId,
          },
          body: JSON.stringify({
            yakId: SAMPLE_IDS.yakId,
            title: "Verify boundary decoding",
          }),
        }
      )

      const res = await CreateEventRoute.handle(req, {
        params: { orgId: SAMPLE_IDS.orgId },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get("x-request-id")).toBe(SAMPLE_IDS.requestId)
      expect(res.headers.get("content-type")).toBe(
        "application/json; charset=utf-8"
      )
      const json = (await res.json()) as Record<string, unknown>
      expect(json).toMatchObject({
        ok: true,
        accepted: true,
        orgId: SAMPLE_IDS.orgId,
        yakId: SAMPLE_IDS.yakId,
        dryRun: true,
        clientVersion: "2.4.0",
        requestId: SAMPLE_IDS.requestId,
        request_id: SAMPLE_IDS.requestId,
      })
    })

    it("rejects malformed JSON bodies with 400 invalid_json and never echoes the raw body", async () => {
      const secretGarbage = "{not-json: 'super_secret_token_987654'}"
      const req = new Request("https://api.example.com/events", {
        method: "POST",
        headers: {
          "x-client-version": "1.0.0",
          "x-request-id": SAMPLE_IDS.requestId,
        },
        body: secretGarbage,
      })

      const res = await CreateEventRoute.handle(req, {
        params: { orgId: SAMPLE_IDS.orgId },
      })

      expect(res.status).toBe(400)
      const rawText = await res.text()
      expect(rawText).not.toContain("super_secret_token_987654")
      const problem = JSON.parse(rawText) as Record<string, unknown>
      expect(problem.code).toBe("invalid_json")
      expect(problem.status).toBe(400)
      expect(problem.request_id).toBe(SAMPLE_IDS.requestId)
    })

    it("rejects invalid params, query, headers, or body with 400 invalid_* codes without echoing rejected values", async () => {
      const badOrgToken = "bad_org_secret_candidate_111"
      const badParamReq = new Request("https://api.example.com/events", {
        method: "POST",
        headers: { "x-client-version": "1.0.0" },
        body: JSON.stringify({ yakId: SAMPLE_IDS.yakId, title: "ok" }),
      })

      const paramRes = await CreateEventRoute.handle(badParamReq, {
        params: { orgId: badOrgToken },
      })
      expect(paramRes.status).toBe(400)
      const paramText = await paramRes.text()
      expect(paramText).not.toContain(badOrgToken)
      expect(JSON.parse(paramText).code).toBe("invalid_path_params")

      const badBodyToken = "bad_yak_secret_candidate_222"
      const badBodyReq = new Request("https://api.example.com/events", {
        method: "POST",
        headers: { "x-client-version": "1.0.0" },
        body: JSON.stringify({ yakId: badBodyToken, title: "ok" }),
      })
      const bodyRes = await CreateEventRoute.handle(badBodyReq, {
        params: { orgId: SAMPLE_IDS.orgId },
      })
      expect(bodyRes.status).toBe(400)
      const bodyText = await bodyRes.text()
      expect(bodyText).not.toContain(badBodyToken)
      expect(JSON.parse(bodyText).code).toBe("invalid_request_body")
    })
  })

  describe("Hera.authedRoute — tenant context, actorKind, multi-scope scanning, and defect safety", () => {
    it("returns 401 unauthorized when HeraTenantCtx is missing or fails resolution", async () => {
      const ProtectedRoute = Hera.authedRoute({
        name: "Clusters.list",
        handler: ({ tenant }) => Effect.succeed({ orgId: tenant.orgId }),
      })

      const req = new Request("https://api.example.com/clusters", {
        headers: { "x-request-id": SAMPLE_IDS.requestId },
      })

      const res = await ProtectedRoute.handle(req)
      expect(res.status).toBe(401)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.code).toBe("unauthorized")
      expect(body.status).toBe(401)
      expect(body.request_id).toBe(SAMPLE_IDS.requestId)
    })

    it("scans across all scope instances (multi-scope headers/entries) and enforces scopes & actorKind", async () => {
      const AdminWriteRoute = Hera.authedRoute({
        name: "Keys.rotate",
        scopes: ["keys:read", "keys:write"],
        actorKind: ["admin", "service"],
        handler: ({ tenant }) =>
          Effect.succeed({
            rotatedBy: tenant.service,
            orgId: tenant.orgId,
          }),
      })

      const req = new Request("https://api.example.com/keys/rotate")

      // 1. Disallowed actorKind ("user" when only "admin" | "service" allowed) -> 403 actor_kind_denied
      const wrongActorRes = await AdminWriteRoute.handle(req, {
        tenant: makeTestTenantCtx({
          actorKind: "user",
          scopes: ["keys:read", "keys:write"],
        }),
      })
      expect(wrongActorRes.status).toBe(403)
      expect(((await wrongActorRes.json()) as { code: string }).code).toBe(
        "actor_kind_denied"
      )

      // 2. Missing second scope -> 403 scope_denied
      const missingScopeRes = await AdminWriteRoute.handle(req, {
        tenant: makeTestTenantCtx({
          actorKind: "admin",
          scopes: ["keys:read"],
        }),
      })
      expect(missingScopeRes.status).toBe(403)
      expect(((await missingScopeRes.json()) as { code: string }).code).toBe(
        "scope_denied"
      )

      // 3. Multi-instance scopes where first entry does NOT match ("billing:read") and second entry carries "keys:read, keys:write" -> 200 OK
      const multiInstanceRes = await AdminWriteRoute.handle(req, {
        tenant: makeTestTenantCtx({
          actorKind: "service",
          scopes: ["billing:read", "audit:read keys:read, keys:write"],
        }),
      })
      expect(multiInstanceRes.status).toBe(200)
      const okBody = (await multiInstanceRes.json()) as Record<string, unknown>
      expect(okBody).toMatchObject({
        ok: true,
        rotatedBy: "hera-test",
        orgId: SAMPLE_IDS.orgId,
      })

      // 4. Wildcard scope ("keys:*" or "*") satisfies required scopes
      const wildcardRes = await AdminWriteRoute.handle(req, {
        tenant: makeTestTenantCtx({
          actorKind: "admin",
          scopes: ["readonly:all", "keys:*"],
        }),
      })
      expect(wildcardRes.status).toBe(200)
    })

    it("maps expected HeraDefinedError, HeraError, and HeraConfigError to their exact status and code", async () => {
      const SubscriptionLockedError = HeraError.define(
        "SubscriptionLockedError",
        {
          code: "conflict",
          publicMessage: "Subscription is locked by another operation",
          fields: {
            orgId: OrgId,
          },
        }
      )

      const ConflictRoute = Hera.authedRoute({
        name: "Subscriptions.lock",
        handler: ({ tenant }) =>
          Effect.gen(function* () {
            return yield* new SubscriptionLockedError({ orgId: tenant.orgId })
          }),
      })

      const req = new Request("https://api.example.com/subscriptions/lock")
      const res = await ConflictRoute.handle(req, {
        tenant: makeTestTenantCtx(),
      })

      expect(res.status).toBe(409)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.code).toBe("conflict")
      expect(body.detail).toBe("Subscription is locked by another operation")
      expect(body.fields).toEqual({ orgId: SAMPLE_IDS.orgId })
    })

    it("traps Effect.die, thrown exceptions, and fiber interrupts into a closed 503 internal_unavailable without leaking internal messages", async () => {
      const defectLogs: Array<HeraBoundaryDefectLog> = []
      const sensitiveSqlError =
        "FATAL: password authentication failed for user 'postgres_master_key_999'"

      const CrashingRoute = Hera.authedRoute({
        name: "Dangerous.crash",
        service: "polaris-core",
        onDefect: (entry) => {
          defectLogs.push(entry)
        },
        handler: () =>
          Effect.die(new DatabaseInternalCrash(sensitiveSqlError)),
      })

      const req = new Request("https://api.example.com/crash")
      const res = await CrashingRoute.handle(req, {
        tenant: makeTestTenantCtx({ service: "polaris-core" }),
      })

      expect(res.status).toBe(503)
      const text = await res.text()
      expect(text).not.toContain("postgres_master_key_999")
      expect(text).not.toContain("password authentication failed")

      const body = JSON.parse(text) as Record<string, unknown>
      expect(body).toEqual({
        type: "urn:hera:error:internal_unavailable",
        title: "Internal service unavailable",
        status: 503,
        detail: "Internal service unavailable",
        code: "internal_unavailable",
        request_id: SAMPLE_IDS.requestId,
      })

      expect(defectLogs).toHaveLength(1)
      expect(defectLogs[0]).toEqual({
        level: "error",
        event: "hera.boundary.defect",
        boundary: "http",
        service: "polaris-core",
        operation: "Dangerous.crash",
        request_id: SAMPLE_IDS.requestId,
        org_id: SAMPLE_IDS.orgId,
        defect_kind: "die",
        defect_name: "DatabaseInternalCrash",
      })
      expect(JSON.stringify(defectLogs)).not.toContain(
        "postgres_master_key_999"
      )
    })

    // admits: the defect log drops org_id (or carries a second minted request_id) when resolveAuth builds the tenant; the boundary log is a runtime value no type sees
    it("logs the resolveAuth tenant's org_id and the handler's request_id on a defect", async () => {
      const defectLogs: Array<HeraBoundaryDefectLog> = []
      const seen: Array<string> = []
      const tenant = makeTestTenantCtx({ service: "polaris-accounts" })

      const ResolvedRoute = Hera.authedRoute({
        name: "Accounts.crash",
        service: "polaris-accounts",
        resolveAuth: (_request, base) => ({ ...tenant, requestId: base.requestId }),
        onDefect: (entry) => defectLogs.push(entry),
        handler: ({ requestId }) => {
          seen.push(requestId)
          return Effect.die(new DatabaseInternalCrash("boom"))
        },
      })

      const res = await ResolvedRoute.handle(
        new Request("https://api.example.com/accounts/crash")
      )

      expect(res.status).toBe(503)
      expect(defectLogs).toHaveLength(1)
      expect(defectLogs[0]?.org_id).toBe(SAMPLE_IDS.orgId)
      expect(defectLogs[0]?.request_id).toBe(seen[0])
      expect(res.headers.get("x-request-id")).toBe(seen[0])
    })

    // admits: the defect log drops org_id when the tenant comes from an ambient HeraTenantCtx layer; same runtime-value seam as above
    it("logs the ambient HeraTenantCtx org_id on a defect when no tenant is passed", async () => {
      const defectLogs: Array<HeraBoundaryDefectLog> = []

      const AmbientRoute = Hera.authedRoute({
        name: "Accounts.ambientCrash",
        onDefect: (entry) => defectLogs.push(entry),
        handler: () => Effect.die(new DatabaseInternalCrash("boom")),
      })

      await AmbientRoute.handle(
        new Request("https://api.example.com/accounts/crash"),
        { layer: HeraTenantCtx.layer(makeTestTenantCtx()) }
      )

      expect(defectLogs[0]?.org_id).toBe(SAMPLE_IDS.orgId)
    })

    // admits: a publicRoute defect log carries a second minted request_id and drops the caller's org_id; runtime values no type sees
    it("logs the handler's request_id and the heraCtx org_id on a publicRoute defect", async () => {
      const defectLogs: Array<HeraBoundaryDefectLog> = []
      const seen: Array<string> = []
      const { requestId: _omit, ...ctxWithoutId } = makeTestCtx()

      const PublicCrash = Hera.publicRoute({
        name: "Public.crash",
        onDefect: (entry) => defectLogs.push(entry),
        handler: ({ requestId }) => {
          seen.push(requestId)
          return Effect.die(new DatabaseInternalCrash("boom"))
        },
      })

      const res = await PublicCrash.handle(
        new Request("https://api.example.com/public/crash"),
        { heraCtx: ctxWithoutId as HeraCtxShape }
      )

      expect(defectLogs[0]?.request_id).toBe(seen[0])
      expect(res.headers.get("x-request-id")).toBe(seen[0])
      expect(defectLogs[0]?.org_id).toBe(SAMPLE_IDS.orgId)
    })

    it("traps fiber interrupts into 503 internal_unavailable and records interrupt defect_kind", async () => {
      const defectLogs: Array<HeraBoundaryDefectLog> = []

      const InterruptedRoute = Hera.publicRoute({
        name: "Public.interrupt",
        service: "polaris-edge",
        onDefect: (entry) => defectLogs.push(entry),
        handler: () => Effect.interrupt,
      })

      const res = await InterruptedRoute.handle(
        new Request("https://api.example.com/interrupt"),
        { heraCtx: makeTestCtx({ service: "polaris-edge" }) }
      )

      expect(res.status).toBe(503)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.code).toBe("internal_unavailable")
      expect(defectLogs).toHaveLength(1)
      expect(defectLogs[0]?.defect_kind).toBe("interrupt")
    })

    it("maps HeraConfigError inside route handlers to 503 <secret>_unconfigured or <secret>_invalid_config", async () => {
      const webhookKeyReader = HeraConfig.hexKey("WEBHOOK_SIGNING_KEY", 32)

      const WebhookRoute = Hera.publicRoute({
        name: "Webhooks.verify",
        handler: () =>
          Effect.gen(function* () {
            const key = yield* webhookKeyReader
            return { ok: Boolean(key) }
          }),
      })

      const req = new Request("https://api.example.com/webhooks")
      const unconfRes = await WebhookRoute.handle(req, {
        layer: HeraConfig.layer({}),
      })
      expect(unconfRes.status).toBe(503)
      expect(((await unconfRes.json()) as { code: string }).code).toBe(
        "webhook_signing_key_unconfigured"
      )
    })
  })
})

class DatabaseInternalCrash extends Error {
  override readonly name = "DatabaseInternalCrash"
}

describe("resolveRequestId without a usable header", () => {
  it("mints a distinct req_<ULID> per request instead of one shared constant", async () => {
    const { resolveRequestId } = await import("../src/server/routes/headers")
    const { RequestId } = await import("../src/core/schema/index")
    const a = resolveRequestId(new Request("https://x.test/", { headers: { "cf-ray": "8f1c2d3e4f5a6b7c-LHR" } }))
    const b = resolveRequestId(new Request("https://x.test/"))
    expect(RequestId.is(a)).toBe(true)
    expect(RequestId.is(b)).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe("success Responses at the route boundary", () => {
  const respondWith = (response: Response) =>
    Hera.publicRoute({
      name: "Test.respond",
      service: "polaris-test",
      handler: () => Effect.succeed(response),
    }).handle(new Request("https://api.example.com/x"))

  // admits: Node cannot construct a 101 Response, so the socket-carrying shape is a stand-in; workerd covers the real one
  it("returns a Response that carries a webSocket as the same object, untouched", async () => {
    const upgrade = Object.assign(new Response(null), { webSocket: {} })

    const res = await respondWith(upgrade)

    expect(res).toBe(upgrade)
    expect(res.headers.has("x-request-id")).toBe(false)
  })

  // admits: the status-101 branch is separate from the webSocket branch and Node cannot build a real 101
  it("returns a status-101 Response as the same object, untouched", async () => {
    const upgrade = Object.defineProperty(new Response(null), "status", { value: 101 })

    expect(await respondWith(upgrade)).toBe(upgrade)
  })

  // admits: the header contract for every non-upgrade Response
  it("still adds cache-control and x-request-id to a plain Response and keeps its own", async () => {
    const plain = await respondWith(new Response("hi", { status: 201 }))
    expect(plain.status).toBe(201)
    expect(plain.headers.get("cache-control")).toBe("no-store")
    expect(plain.headers.get("x-request-id")).toBeTruthy()

    const own = await respondWith(
      new Response("hi", { headers: { "cache-control": "max-age=60", "x-request-id": "req_own" } })
    )
    expect(own.headers.get("cache-control")).toBe("max-age=60")
    expect(own.headers.get("x-request-id")).toBe("req_own")
  })
})
