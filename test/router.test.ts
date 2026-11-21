import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  Hera,
  HeraCtx,
  HeraTenantCtx,
  type HeraPrefixAccess,
  matchPrefixRoute,
  matchRoutePath,
  OrgId,
} from "../src/index"
import {
  makeTestRouteRequest,
  makeTestTenantCtx,
  parseProblemDetailsResponse,
  SAMPLE_IDS,
} from "../src/testing/index"

const echo = (name: string, method: string | undefined, path: string) =>
  Hera.publicRoute({
    name,
    method,
    path,
    service: "router-test",
    handler: ({ params }) =>
      Effect.gen(function* () {
        yield* HeraCtx
        return { route: name, params }
      }),
  })

const yaks = Hera.router(
  [
    echo("Yaks.create", "POST", "/yaks"),
    echo("Yaks.getConfig", "GET", "/yaks/config"),
    echo("Yaks.putConfig", "PUT", "/yaks/config"),
    echo("Yaks.get", "GET", "/yaks/:key"),
    echo("Yaks.deleteReceipt", "DELETE", "/yaks/:key/receipts/:receiptId"),
  ],
  { prefix: "/v1" }
)

async function body(res: Response): Promise<{ route: string; params: Record<string, string> }> {
  return (await res.json()) as { route: string; params: Record<string, string> }
}

describe("Hera.router — method + path dispatch", () => {
  // admits: a route reached by the wrong method or path, or with undecoded params; dispatch is a runtime
  // match over request strings no type sees.
  it("dispatches a 5-route table by method and path, with params", async () => {
    const created = await yaks(makeTestRouteRequest({ method: "POST", path: "/v1/yaks" }))
    expect(created.status).toBe(200)
    expect((await body(created)).route).toBe("Yaks.create")

    const put = await yaks(makeTestRouteRequest({ method: "PUT", path: "/v1/yaks/config" }))
    expect((await body(put)).route).toBe("Yaks.putConfig")

    const got = await yaks(makeTestRouteRequest({ path: "/v1/yaks/a%20b" }))
    expect(await body(got)).toMatchObject({ route: "Yaks.get", params: { key: "a b" } })

    const del = await yaks(
      makeTestRouteRequest({ method: "DELETE", path: "/v1/yaks/k1/receipts/r9" })
    )
    expect((await body(del)).params).toEqual({ key: "k1", receiptId: "r9" })
  })

  // admits: an OpenAPI-form `{param}` route (a docs table's `/evidence/{fragment_id}`) never matching,
  // or its handler missing the param; dispatch is a runtime string match no type sees.
  it("treats a {name} segment as a path parameter, after earlier literal rows", async () => {
    const evidence = Hera.router([
      echo("Evidence.latest", "GET", "/v1/notebook/evidence/latest"),
      echo("Evidence.get", "GET", "/v1/notebook/evidence/{fragment_id}"),
    ])
    const got = await evidence(makeTestRouteRequest({ path: "/v1/notebook/evidence/frag_1" }))
    expect(await body(got)).toMatchObject({ route: "Evidence.get", params: { fragment_id: "frag_1" } })
    const latest = await evidence(makeTestRouteRequest({ path: "/v1/notebook/evidence/latest" }))
    expect((await body(latest)).route).toBe("Evidence.latest")
  })

  // admits: a `:param` row shadowing a literal row (yak `/config` vs `/:key`); order is runtime.
  it("takes the first match in table order, so a literal row beats a later :param row", async () => {
    const res = await yaks(makeTestRouteRequest({ path: "/v1/yaks/config" }))
    expect((await body(res)).route).toBe("Yaks.getConfig")
  })

  // admits: an unrouted path falling through to a near-miss route or a non-problem body; runtime bytes.
  it("answers an unknown path with a problem+json 404 route_not_found", async () => {
    for (const path of ["/v1/nope", "/v1/yaks/a/b", "/yaks", "/v1/yaksx"]) {
      const res = await yaks(makeTestRouteRequest({ path }))
      expect(res.status).toBe(404)
      expect(res.headers.get("content-type")).toContain("application/problem+json")
      expect(res.headers.get("x-request-id")).toBe(SAMPLE_IDS.requestId)
      const problem = await parseProblemDetailsResponse(res)
      expect(problem.code).toBe("route_not_found")
    }
  })

  // admits: a 405 without `Allow` (RFC 9110 MUST) or with a duplicated method; runtime header.
  it("answers a known path with the wrong method with 405 and Allow in table order", async () => {
    const res = await yaks(makeTestRouteRequest({ method: "DELETE", path: "/v1/yaks/config" }))
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET, PUT")
    expect(res.headers.get("content-type")).toContain("application/problem+json")
    expect((await parseProblemDetailsResponse(res)).code).toBe("method_not_allowed")
  })

  // admits: a method-less route refused as 405; runtime match.
  it("lets a method-less route take any method", async () => {
    const any = Hera.router([echo("Any.handle", undefined, "/any")])
    const res = await any(makeTestRouteRequest({ method: "PATCH", path: "/any" }))
    expect((await body(res)).route).toBe("Any.handle")
  })

  // admits: a custom refusal hook ignored; runtime branch.
  it("uses custom notFound and methodNotAllowed responses", async () => {
    const custom = Hera.router([echo("Only.get", "GET", "/only")], {
      notFound: () => new Response("gone", { status: 404 }),
      methodNotAllowed: (_request, allow) => new Response(allow.join("|"), { status: 405 }),
    })
    expect(await (await custom(makeTestRouteRequest({ path: "/x" }))).text()).toBe("gone")
    const wrong = await custom(makeTestRouteRequest({ method: "POST", path: "/only" }))
    expect(await wrong.text()).toBe("GET")
  })

  // admits: a pathless route silently never matching; `HeraRoute.path` is optional in the type.
  it("throws at construction when a route has no path", () => {
    const pathless = Hera.publicRoute({
      name: "Pathless.get",
      handler: () => Effect.succeed({}),
    })
    expect(() => Hera.router([pathless])).toThrow(/Pathless\.get.*no path/)
  })

  // admits: the gateway ctx not reaching a tenantRoute handler (AC 3); the tenant is an invoke-time
  // value threaded through `"tenant" in opts`, which no type enforces.
  it("lets a ProductRpc handle(request, ctx) dispatch tenantRoute handlers under the gateway ctx", async () => {
    type GatewayCtx = { readonly orgId: string; readonly scopes: ReadonlyArray<string> }
    const getStatus = Hera.authedRoute({
      name: "Yak.status",
      method: "GET",
      path: "/v1/yaks/status",
      service: "yak",
      scopes: ["yak:read"],
      handler: () =>
        Hera.tenantRoute(
          Effect.gen(function* () {
            const tenant = yield* HeraTenantCtx
            return { orgId: tenant.orgId }
          })
        ),
    })
    const getReceipt = Hera.authedRoute({
      name: "Yak.receipt",
      method: "GET",
      path: "/v1/yaks/receipts/:key",
      service: "yak",
      params: Schema.Struct({ key: Schema.NonEmptyString }),
      handler: ({ params, orgId }) =>
        Hera.tenantRoute(Effect.succeed({ key: params.key, orgId })),
    })
    const dispatch = Hera.router([getStatus, getReceipt])
    const product = {
      handle: (request: Request, ctx: GatewayCtx): Promise<Response> =>
        dispatch(request, {
          tenant: makeTestTenantCtx({
            orgId: Schema.decodeUnknownSync(OrgId)(ctx.orgId),
            service: "yak",
            scopes: ctx.scopes,
          }),
        }),
    }
    const ctx: GatewayCtx = { orgId: SAMPLE_IDS.orgId, scopes: ["yak:read"] }

    const status = await product.handle(makeTestRouteRequest({ path: "/v1/yaks/status" }), ctx)
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ orgId: SAMPLE_IDS.orgId })

    const receipt = await product.handle(
      makeTestRouteRequest({ path: "/v1/yaks/receipts/r1" }),
      ctx
    )
    expect(await receipt.json()).toMatchObject({ key: "r1", orgId: SAMPLE_IDS.orgId })

    const denied = await product.handle(makeTestRouteRequest({ path: "/v1/yaks/status" }), {
      ...ctx,
      scopes: [],
    })
    expect(denied.status).toBe(403)
  })
})

describe("matchRoutePath", () => {
  // admits: a pattern matching a path of another arity or literal; string runtime property.
  it.each([
    ["/v1/yaks/:id", "/v1/yaks/1", true],
    ["/v1/yaks/:id", "/v1/yaks/1/", true],
    ["/v1/yaks/:id", "/v1/yaks", false],
    ["/v1/yaks/:id", "/v1/other/1", false],
    ["/v1/yaks", "/v1/yaks/1", false],
    ["/", "/", true],
    ["/v1/notebook/evidence/{fragment_id}", "/v1/notebook/evidence/frag_1", true],
    ["/v1/notebook/evidence/{fragment_id}", "/v1/notebook/evidence", false],
  ])("%s vs %s → %s", (pattern, pathname, expected) => {
    expect(matchRoutePath(pattern, pathname)).toBe(expected)
  })
})

describe("Hera.prefixRouter — gateway prefix rows", () => {
  const rows = [
    {
      prefix: "/v1/yaks",
      product: "yak",
      binding: "YAK",
      access: { POST: "write", PUT: "write", GET: "read" },
    },
    { prefix: "/v1/gates", product: "linear-proxy", binding: "GATES", access: { POST: "write", GET: "read" } },
    { prefix: "/v1/gates/admin", product: "linear-proxy", binding: "GATES_ADMIN", access: { GET: "admin" } },
  ] as const
  const gateway = Hera.prefixRouter(rows)
  const req = (method: string, path: string) => makeTestRouteRequest({ method, path })

  // admits: `/v1/yaks` matching `/v1/yaksx` (org-gateway segment-boundary invariant); runtime string.
  it("matches on a segment boundary only", () => {
    expect(matchPrefixRoute("/v1/yaks", rows)?.binding).toBe("YAK")
    expect(matchPrefixRoute("/v1/yaks/config", rows)?.binding).toBe("YAK")
    expect(matchPrefixRoute("/v1/yaksx", rows)).toBeUndefined()
    expect(matchPrefixRoute("/v1", rows)).toBeUndefined()
  })

  // admits: a shorter prefix shadowing a nested one by row order; runtime.
  it("picks the longest prefix whatever the row order", () => {
    expect(matchPrefixRoute("/v1/gates/admin/x", rows)?.binding).toBe("GATES_ADMIN")
    expect(matchPrefixRoute("/v1/gates/admin/x", [...rows].reverse())?.binding).toBe("GATES_ADMIN")
    expect(matchPrefixRoute("/v1/gates/administer", rows)?.binding).toBe("GATES")
  })

  // admits: the wrong access for a method (POST read instead of write); runtime map lookup.
  it("returns the access level for the matched method", () => {
    expect(gateway.match(req("PUT", "/v1/yaks/config"))).toMatchObject({
      _tag: "Matched",
      access: "write",
      route: { binding: "YAK", product: "yak" },
    })
    expect(gateway.match(req("GET", "/v1/yaks/status"))).toMatchObject({ access: "read" })
  })

  // admits: an absent or `Object.prototype`-named method resolving to an access; runtime lookup.
  it("never maps an unnamed or inherited method to an access", () => {
    expect(gateway.match(req("DELETE", "/v1/yaks"))).toMatchObject({
      _tag: "MethodNotAllowed",
      allow: ["POST", "PUT", "GET"],
    })
    // Raw requests: `makeTestRouteRequest` uppercases, and `Object.prototype.TOSTRING` is undefined.
    for (const method of ["toString", "constructor", "__proto__"]) {
      const raw = new Request("https://hera.test/v1/yaks", { method })
      expect(gateway.match(raw)._tag).toBe("MethodNotAllowed")
    }
  })

  // admits: a row-union access type that keeps only the levels every row shares, so a reachable
  // level is unassignable; a type-level property, held here by a compile-time assignment.
  it("types the access level as the union over every row", () => {
    const write: HeraPrefixAccess<(typeof rows)[number]> = "write"
    const admin: HeraPrefixAccess<(typeof rows)[number]> = "admin"
    expect([write, admin]).toEqual(["write", "admin"])
  })

  // admits: `Allow` naming a method the row maps to `undefined`, which the same row refuses;
  // `Partial<Record>` admits the explicit undefined.
  it("leaves undefined access entries out of Allow", () => {
    const partial = Hera.prefixRouter([
      { prefix: "/v1/yaks", binding: "YAK", access: { GET: "read", POST: undefined } },
    ])
    expect(partial.match(req("POST", "/v1/yaks"))).toMatchObject({
      _tag: "MethodNotAllowed",
      allow: ["GET"],
    })
  })

  // admits: forward called on a refusal, or a refusal that is not problem+json; runtime.
  it("answers refusals as problem+json and forwards a match with its access", async () => {
    const forwarded: Array<string> = []
    const forward = ({ route, access }: { route: { binding: string }; access: string }) => {
      forwarded.push(`${route.binding}:${access}`)
      return new Response("ok")
    }
    const missing = await gateway.handle(req("GET", "/v1/yaksx"), forward)
    expect(missing.status).toBe(404)
    expect((await parseProblemDetailsResponse(missing)).code).toBe("route_not_found")

    const wrong = await gateway.handle(req("DELETE", "/v1/gates"), forward)
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get("allow")).toBe("POST, GET")
    expect(wrong.headers.get("content-type")).toContain("application/problem+json")

    const ok = await gateway.handle(req("POST", "/v1/gates/receipts"), forward)
    expect(await ok.text()).toBe("ok")
    expect(forwarded).toEqual(["GATES:write"])
  })

  // admits: a trailing-slash prefix that never matches its own children, or a duplicate prefix
    // whose second row is dead; the template type allows both.
    it("throws at construction on a trailing-slash or duplicate prefix", () => {
    expect(() => Hera.prefixRouter([{ prefix: "/v1/yaks/", binding: "YAK", access: {} }])).toThrow(
      /ends in/
    )
    expect(() =>
      Hera.prefixRouter([
        { prefix: "/v1/yaks", binding: "A", access: {} },
        { prefix: "/v1/yaks", binding: "B", access: {} },
      ])
    ).toThrow(/listed twice/)
  })
})
