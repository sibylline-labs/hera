import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  type HeraAuthorityCtx,
  HeraAuthorityVerifier,
  refuseAuthority,
} from "../src/core/authority/index.js"
import { HeraHttpError, RateLimitedError } from "../src/core/http/index.js"
import { ErrorSlug } from "../src/core/schema/index.js"
import { Hera, type HeraBoundaryDefectLog, HeraError } from "../src/index.js"
import { HeraTest, makeTestTenantCtx } from "../src/testing/index.js"

const SECRET = "grant_01JC0000000000000000000000_s3cr3tRouteMarker"

const SkipBody = Schema.Struct({
  gate: Schema.String,
  grant: Schema.optional(Schema.String),
})

interface Seen {
  calls: number
  ctx: Array<HeraAuthorityCtx<"gate:skip">>
  reads: number
}

function seen(): Seen {
  return { calls: 0, ctx: [], reads: 0 }
}

function skipRoute(verifier: Layer.Layer<HeraAuthorityVerifier, HeraError>, s: Seen) {
  return Hera.authedRoute({
    name: "Gates.skip",
    method: "POST",
    path: "/v1/skip",
    body: SkipBody,
    authority: {
      verb: "gate:skip",
      credential: (ctx) => {
        s.reads++
        return ctx.body.grant
      },
      params: (ctx) => ({ gate: ctx.body.gate }),
      verifier,
    },
    handler: (_ctx, authority) =>
      Effect.sync(() => {
        s.calls++
        s.ctx.push(authority)
        return { grant: authority.grant.id, verb: authority.verb }
      }),
  })
}

function post(body: Record<string, unknown>): Request {
  return new Request("http://hera.test/v1/skip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const tenant = makeTestTenantCtx()

async function invoke(
  route: ReturnType<typeof skipRoute>,
  body: Record<string, unknown>,
  defects: HeraBoundaryDefectLog[] = []
): Promise<{ readonly res: Response; readonly text: string }> {
  const res = await route(post(body), { tenant, onDefect: (e) => void defects.push(e) })
  const text = await res.text()
  const headers = JSON.stringify([...res.headers.entries()])
  expect(text).not.toContain(SECRET)
  expect(headers).not.toContain(SECRET)
  expect(JSON.stringify(defects)).not.toContain(SECRET)
  return { res, text }
}

function failingVerifier(err: unknown): Layer.Layer<HeraAuthorityVerifier> {
  return HeraAuthorityVerifier.layer({ verify: () => Effect.fail(err as never) })
}

describe("Hera.authedRoute authority boundary", () => {
  // admits: integration — the real route boundary, fake verifier and problem renderer together
  // decide whether the handler runs and with which grant; a regression drops or forges the grant.
  it("hands the handler the grant, verb and params, reading the credential once", async () => {
    const fake = HeraTest.authority({ verbs: { "gate:skip": { grant: { id: "use-1" } } }, credential: SECRET })
    const s = seen()
    const { res, text } = await invoke(skipRoute(fake.layer, s), { gate: "plan-review", grant: SECRET })
    expect(res.status).toBe(200)
    expect(JSON.parse(text).data).toEqual({ grant: "use-1", verb: "gate:skip" })
    expect(s.calls).toBe(1)
    expect(s.reads).toBe(1)
    expect(s.ctx[0]?.params).toEqual({ gate: "plan-review" })
    expect(Redacted.value(s.ctx[0]!.credential)).toBe(SECRET)
    expect(fake.requests).toEqual([{ verb: "gate:skip", params: { gate: "plan-review" }, command: "Gates.skip" }])
  })

  // admits: integration — a refusal must reach the wire as 403 problem+json with the verifier's own
  // slug, and the handler must not run.
  it("renders a refusal as 403 problem+json carrying the verifier's slug", async () => {
    const fake = HeraTest.authority({ verbs: { "gate:skip": { refuse: { slug: "grant-expired", what: "the grant expired" } } } })
    const s = seen()
    const { res, text } = await invoke(skipRoute(fake.layer, s), { gate: "g", grant: SECRET })
    expect(res.status).toBe(403)
    expect(res.headers.get("content-type")).toContain("application/problem+json")
    const body = JSON.parse(text)
    expect(body).toMatchObject({ type: "urn:hera:error:forbidden", code: "forbidden", slug: "grant-expired", what: "the grant expired" })
    expect(s.calls).toBe(0)
  })

  // admits: algorithmic — an absent or empty credential refuses without asking the verifier.
  it.each([[{ gate: "g" }], [{ gate: "g", grant: "" }]])("refuses a missing credential without calling the verifier (%j)", async (body) => {
    const fake = HeraTest.authority({ verbs: { "gate:skip": { grant: { id: "use-1" } } } })
    const s = seen()
    const { res, text } = await invoke(skipRoute(fake.layer, s), body)
    expect(res.status).toBe(403)
    expect(JSON.parse(text)).toMatchObject({ code: "forbidden", slug: "authority-credential-missing" })
    expect(fake.requests).toEqual([])
    expect(s.calls).toBe(0)
  })

  // admits: algorithmic — the exact credential is cut from every refusal field, and a slug that
  // carries it falls back to `authority-refused`.
  it("redacts the exact credential from a refusal's slug, what and fix", async () => {
    const leaky = failingVerifier(refuseAuthority(`bad-${SECRET.toLowerCase().replace(/_/g, "-")}`, { what: `no grant for ${SECRET}`, fix: `rotate ${SECRET}` }))
    const lower = SECRET.toLowerCase().replace(/_/g, "-")
    const s = seen()
    const route = skipRoute(leaky, s)
    const res = await route(post({ gate: "g", grant: lower }), { tenant })
    const body = await res.json() as Record<string, unknown>
    expect(res.status).toBe(403)
    expect(body.slug).toBe("authority-refused")
    expect(JSON.stringify(body)).not.toContain(lower)
    const s2 = seen()
    const { text } = await invoke(skipRoute(leaky, s2), { gate: "g", grant: SECRET })
    expect(JSON.parse(text)).toMatchObject({ what: "no grant for [REDACTED]", fix: "rotate [REDACTED]" })
    expect(s.calls + s2.calls).toBe(0)
  })

  // admits: algorithmic — transport failures become a typed retryable 503 with no transport text.
  it("maps a verifier transport failure to a retryable 503 with no transport text", async () => {
    const http = new HeraHttpError({ reason: "NetworkError", slug: ErrorSlug.make("http-network"), url: `https://v.test/${SECRET}`, method: "POST" })
    const s = seen()
    const { res, text } = await invoke(skipRoute(failingVerifier(http), s), { gate: "g", grant: SECRET })
    expect(res.status).toBe(503)
    expect(JSON.parse(text)).toMatchObject({ code: "service_unavailable", slug: "authority-verifier-unavailable" })
    const limited = new RateLimitedError({ slug: ErrorSlug.make("rate-limited"), status: 429, url: `https://v.test/${SECRET}`, method: "POST", retryAfterSeconds: 7, retryAfterMs: 7000 })
    const r2 = await invoke(skipRoute(failingVerifier(limited), s), { gate: "g", grant: SECRET })
    expect(r2.res.status).toBe(503)
    expect(r2.res.headers.get("retry-after")).toBe("7")
    expect(s.calls).toBe(0)
  })

  // admits: algorithmic — a verifier layer that fails to build is redacted and loses its cause.
  it("redacts the credential from a verifier layer build failure", async () => {
    const broken = Layer.effect(HeraAuthorityVerifier, Effect.fail(HeraError.badGateway(`verifier down for ${SECRET}`, { fields: { detail: `saw ${SECRET}` }, cause: new Error(SECRET) })))
    const s = seen()
    const { res, text } = await invoke(skipRoute(broken, s), { gate: "g", grant: SECRET })
    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toMatchObject({ detail: "verifier down for [REDACTED]", fields: { detail: "saw [REDACTED]" } })
    expect(s.calls).toBe(0)
  })

  // admits: algorithmic — a verifier that throws dies with a fixed defect, so neither the closed 503
  // nor the defect log carries the thrown value.
  it("replaces a thrown verifier value with a fixed defect", async () => {
    const thrower = HeraAuthorityVerifier.layer({ verify: () => Effect.die({ _tag: SECRET, message: SECRET }) })
    const defects: HeraBoundaryDefectLog[] = []
    const s = seen()
    const { res } = await invoke(skipRoute(thrower, s), { gate: "g", grant: SECRET }, defects)
    expect(res.status).toBe(503)
    expect(defects.map((d) => d.defect_name)).toEqual(["HeraAuthorityVerifierDefect"])
    expect(s.calls).toBe(0)
  })
})

describe("Hera.authedRoute authority types", () => {
  // admits: integration — tsc over the real `authedRoute` overloads is the type rung; every
  // expect-error directive below fails the typecheck if an unguarded route or another verb ever accepts the ctx.
  it("types the ctx by the declared verb, and only on a guarded route", () => {
    const fake = HeraTest.authority()
    Hera.authedRoute({
      method: "GET",
      // @ts-expect-error an unguarded route hands its handler no authority ctx
      handler: (_ctx, _authority: HeraAuthorityCtx<"gate:skip">) => Effect.succeed(1),
    })
    // @ts-expect-error nor an unannotated second parameter
    Hera.authedRoute({ method: "GET", handler: (_ctx, authority) => Effect.succeed(authority) })
    Hera.authedRoute({
      method: "GET",
      authority: { verb: "gate:skip", credential: () => "c", verifier: fake.layer },
      handler: (_ctx, authority) => {
        expectTypeOf(authority).toEqualTypeOf<HeraAuthorityCtx<"gate:skip">>()
        return Effect.succeed(authority.grant.id)
      },
    })
    Hera.authedRoute({
      method: "GET",
      authority: { verb: "gate:skip", credential: () => "c", verifier: fake.layer },
      // @ts-expect-error a handler typed for another verb does not fit
      handler: (_ctx, _authority: HeraAuthorityCtx<"gate:merge">) => Effect.succeed(1),
    })
  })
})
