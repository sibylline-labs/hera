import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { Hera, HeraError, HeraHttp } from "../src/index"
import { makeTestTenantCtx, SAMPLE_IDS } from "../src/testing/index"

const DEVICE_CODE = {
  device_code: "dc_123",
  user_code: "WDJB-MJHT",
  verification_uri: "https://polaris.example/device",
  expires_in: 900,
  interval: 5,
}

function post(path: string): Request {
  return new Request(`https://polaris.example${path}`, {
    method: "POST",
    headers: { "x-request-id": SAMPLE_IDS.requestId },
  })
}

// Type rung: a raw reply takes only a body-carrying 2xx. Never called; `bun run typecheck` holds it.
export function rawStatusIsBodyCarrying2xx(): void {
  // @ts-expect-error 204 carries no body
  HeraHttp.raw({}, { status: 204 })
  // @ts-expect-error a failure is a HeraError, never a raw reply
  HeraHttp.raw({}, { status: 400 })
}

describe("HeraHttp.raw — a route success answered as the bare JSON value", () => {
  // admits: a raw reply reaching the client wrapped, without no-store, or without the route's
  // request id; the bytes exist only at runtime, after the route boundary's serializer.
  it("answers through a publicRoute as exactly the value, the chosen 2xx, application/json and no-store", async () => {
    const DeviceCode = Hera.publicRoute({
      method: "POST",
      path: "/v1/device/code",
      service: "polaris-gateway",
      handler: () => Effect.succeed(HeraHttp.raw(DEVICE_CODE, { status: 201 })),
    })

    const res = await DeviceCode(post("/v1/device/code"))
    expect(res.status).toBe(201)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-request-id")).toBe(SAMPLE_IDS.requestId)
    expect(await res.text()).toBe(JSON.stringify(DEVICE_CODE))
  })

  // admits: authedRoute serializing a raw success differently from publicRoute; runtime bytes.
  it("answers through an authedRoute unwrapped, defaulting to 200", async () => {
    const tenant = makeTestTenantCtx()
    const Session = Hera.authedRoute({
      method: "POST",
      path: "/v1/session",
      handler: ({ orgId }) => Effect.succeed(HeraHttp.raw({ org_id: orgId })),
    })

    const res = await Session(post("/v1/session"), { tenant })
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.text()).toBe(JSON.stringify({ org_id: tenant.orgId }))
  })

  // admits: a non-object value (array, scalar, null) re-wrapped, or cacheControl dropped by the
  // boundary's no-store default; runtime bytes and header merge.
  it("keeps arrays and scalars bare and lets cacheControl override no-store", async () => {
    expect(await HeraHttp.raw([1, 2]).text()).toBe("[1,2]")
    expect(await HeraHttp.raw(null).text()).toBe("null")
    expect(() => HeraHttp.raw(undefined)).toThrow(TypeError)

    const Jwks = Hera.publicRoute({
      method: "GET",
      path: "/.well-known/jwks.json",
      handler: () =>
        Effect.succeed(
          HeraHttp.raw({ keys: [] }, { cacheControl: "public, max-age=300" })
        ),
    })
    const res = await Jwks(new Request("https://polaris.example/.well-known/jwks.json"))
    expect(res.headers.get("cache-control")).toBe("public, max-age=300")
    expect(await res.text()).toBe('{"keys":[]}')
  })

  // admits: the opt-in leaking into routes that did not opt in (envelope and problem+json are the
  // documented contract in docs/ERRORS.md); runtime bytes.
  it("leaves a plain value enveloped and a failure problem+json", async () => {
    const Enveloped = Hera.publicRoute({
      method: "POST",
      path: "/v1/things",
      status: 201,
      handler: () => Effect.succeed({ id: "t_1" }),
    })
    const ok = await Enveloped(post("/v1/things"))
    expect(ok.status).toBe(201)
    expect(await ok.json()).toEqual({
      ok: true,
      id: "t_1",
      data: { id: "t_1" },
      request_id: SAMPLE_IDS.requestId,
    })

    const Pending = Hera.publicRoute({
      method: "POST",
      path: "/v1/device/token",
      handler: () => HeraError.conflict("authorization_pending"),
    })
    const failed = await Pending(post("/v1/device/token"))
    expect(failed.status).toBe(409)
    expect(failed.headers.get("content-type")).toMatch(/^application\/problem\+json/)
    expect(((await failed.json()) as Record<string, unknown>).ok).toBeUndefined()
  })
})
