import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  Hera,
  type HeraBoundaryDefectLog,
  HeraError,
  type HeraRpcClient,
  type HeraRpcMethod,
  HeraTenantCtx,
  OrgId,
  YakId,
} from "../src/index"
import {
  SAMPLE_IDS,
  withTestCtx,
  withTestTenantCtx,
} from "../src/testing/index"

describe("Hera.rpcMethod & Hera.rpcClient — Structured-Clone-safe RPC boundary", () => {
  const ClusterLookupError = HeraError.define("ClusterLookupError", {
    code: "not_found",
    publicMessage: "Cluster was not found for organization",
    fields: {
      orgId: OrgId,
      yakId: YakId,
    },
  })

  const resolveClusterRpc = Hera.rpcMethod({
    name: "Relay.resolveCluster",
    service: "relay",
    input: Schema.Struct({
      orgId: OrgId,
      yakId: YakId,
      mode: Schema.Literals(["ok", "domain_error", "defect"]),
    }),
    handler: (input) =>
      Effect.gen(function* () {
        const tenant = yield* HeraTenantCtx
        if (input.mode === "domain_error") {
          return yield* new ClusterLookupError({
            orgId: input.orgId,
            yakId: input.yakId,
          })
        }
        if (input.mode === "defect") {
          return yield* Effect.die(
            new Error("INTERNAL_D1_SQLITE_CORRUPTION_SECRET_PATH")
          )
        }
        return {
          clusterName: `cluster-${input.yakId}`,
          orgId: tenant.orgId,
          service: tenant.service,
        }
      }),
  })

  it("marshals Effect success and failure into Structured-Clone-safe POJOs across structuredClone()", async () => {
    const okWire = await resolveClusterRpc(
      {
        orgId: SAMPLE_IDS.orgId,
        yakId: SAMPLE_IDS.yakId,
        mode: "ok",
      },
      {
        requestId: SAMPLE_IDS.requestId,
        orgId: SAMPLE_IDS.orgId,
        actorId: SAMPLE_IDS.actorId,
      }
    )

    // Must survive structuredClone (workerd JsRpc boundary check)
    const clonedOk = structuredClone(okWire)
    expect(clonedOk).toEqual({
      ok: true,
      value: {
        clusterName: `cluster-${SAMPLE_IDS.yakId}`,
        orgId: SAMPLE_IDS.orgId,
        service: "relay",
      },
    })
    expect(Object.getPrototypeOf(clonedOk)).toBe(Object.prototype)

    const errWire = await resolveClusterRpc(
      {
        orgId: SAMPLE_IDS.orgId,
        yakId: SAMPLE_IDS.yakId,
        mode: "domain_error",
      },
      {
        requestId: SAMPLE_IDS.requestId,
        orgId: SAMPLE_IDS.orgId,
      }
    )

    const clonedErr = structuredClone(errWire)
    expect(clonedErr).toEqual({
      ok: false,
      status: 404,
      code: "not_found",
      error: "not_found",
      message: "Cluster was not found for organization",
      requestId: SAMPLE_IDS.requestId,
      fields: {
        orgId: SAMPLE_IDS.orgId,
        yakId: SAMPLE_IDS.yakId,
      },
    })
    expect(Object.getPrototypeOf(clonedErr)).toBe(Object.prototype)
  })

  it("rejects invalid RPC input with 400 invalid_rpc_input POJO without echoing sensitive input", async () => {
    const secretBadId = "secret_malformed_org_id_rpc_999"
    const wire = await resolveClusterRpc({
      orgId: secretBadId as unknown as typeof SAMPLE_IDS.orgId,
      yakId: SAMPLE_IDS.yakId,
      mode: "ok",
    })

    const cloned = structuredClone(wire)
    expect(cloned.ok).toBe(false)
    if (!cloned.ok) {
      expect(cloned.status).toBe(400)
      expect(cloned.code).toBe("invalid_rpc_input")
      expect(JSON.stringify(cloned)).not.toContain(secretBadId)
    }
  })

  it("traps defects inside rpcMethod into 503 <service>_unavailable POJO without throwing across JsRpc", async () => {
    const defectLogs: Array<HeraBoundaryDefectLog> = []
    const crashingMethod = Hera.rpcMethod({
      name: "Relay.crash",
      service: "relay",
      onDefect: (log) => defectLogs.push(log),
      handler: () =>
        Effect.die(new Error("SENSITIVE_STACK_TRACE_TOKEN_abc123")),
    })

    const wire = await crashingMethod(undefined, {
      requestId: SAMPLE_IDS.requestId,
      orgId: SAMPLE_IDS.orgId,
    })

    const cloned = structuredClone(wire)
    expect(cloned).toEqual({
      ok: false,
      status: 503,
      code: "relay_unavailable",
      error: "relay_unavailable",
      message: "Upstream service unavailable",
      requestId: SAMPLE_IDS.requestId,
    })
    expect(JSON.stringify(cloned)).not.toContain(
      "SENSITIVE_STACK_TRACE_TOKEN_abc123"
    )
    expect(defectLogs).toHaveLength(1)
    expect(defectLogs[0]?.boundary).toBe("rpc")
    expect(defectLogs[0]?.defect_kind).toBe("die")
  })

  it("unmarshals Hera.rpcMethod responses in Hera.rpcClient and propagates HeraTenantCtx metadata automatically", async () => {
    const fakeServiceBinding = {
      resolveCluster: resolveClusterRpc,
    }

    const client = Hera.rpcClient(fakeServiceBinding, {
      service: "relay",
    })

    // 1. Success path with automatic HeraTenantCtx forwarding
    const okResult = await Effect.runPromise(
      withTestTenantCtx(
        client.resolveCluster({
          orgId: SAMPLE_IDS.orgId,
          yakId: SAMPLE_IDS.yakId,
          mode: "ok",
        })
      )
    )
    expect(okResult).toEqual({
      clusterName: `cluster-${SAMPLE_IDS.yakId}`,
      orgId: SAMPLE_IDS.orgId,
      service: "relay",
    })

    // 2. Typed domain error path rehydrates into HeraError with status 404 & fields
    const domainErr = await Effect.runPromise(
      Effect.flip(
        withTestTenantCtx(
          client.resolveCluster({
            orgId: SAMPLE_IDS.orgId,
            yakId: SAMPLE_IDS.yakId,
            mode: "domain_error",
          })
        )
      )
    )
    expect(HeraError.is(domainErr)).toBe(true)
    expect(domainErr.status).toBe(404)
    expect(domainErr.code).toBe("not_found")
    expect(domainErr.fields).toEqual({
      orgId: SAMPLE_IDS.orgId,
      yakId: SAMPLE_IDS.yakId,
    })
  })

  it("maps workerd JsRpc transport rejections ('Network connection lost.') to 503 <service>_unavailable with retryable=true", async () => {
    const transportEvents: Array<{
      readonly service: string
      readonly method: string
      readonly retryable: boolean
      readonly errorName: string
      readonly attempt: number
      readonly timedOut: boolean
    }> = []

    const brokenBinding = {
      async ingestEvent(_payload: { readonly id: string }) {
        throw new Error(
          "Network connection lost. internal_stub_address=10.0.0.42"
        )
      },
    }

    const client = Hera.rpcClient(brokenBinding, {
      service: "console",
      onTransportError: (info) => transportEvents.push(info),
    })

    const err = await Effect.runPromise(
      Effect.flip(
        withTestCtx(client.ingestEvent({ id: "evt_1" }), {
          service: "gateway",
        })
      )
    )

    expect(HeraError.is(err)).toBe(true)
    expect(err.status).toBe(503)
    expect(err.code).toBe("console_unavailable")
    expect(err.fields).toEqual({
      service: "console",
      method: "ingestEvent",
      retryable: true,
    })
    expect(JSON.stringify(err.toProblemDetails())).not.toContain("10.0.0.42")
    expect(transportEvents).toEqual([
      {
        service: "console",
        method: "ingestEvent",
        retryable: true,
        errorName: "Error",
        attempt: 1,
        timedOut: false,
      },
    ])
  })

  it("rehydrates an RFC 7807 problem details value (no `ok`) into a typed HeraError", async () => {
    const problem = await new ClusterLookupError({
      orgId: SAMPLE_IDS.orgId,
      yakId: SAMPLE_IDS.yakId,
    })
      .toResponse({ requestId: SAMPLE_IDS.requestId })
      .json()
    const binding = {
      async resolveCluster() {
        return problem
      },
    }
    const client = Hera.rpcClient(binding, { service: "relay" })

    const err = await Effect.runPromise(
      Effect.flip(withTestCtx(client.resolveCluster()))
    )

    expect(problem).not.toHaveProperty("ok")
    expect(HeraError.is(err)).toBe(true)
    expect(err.status).toBe(404)
    expect(err.code).toBe("not_found")
    expect(err.requestId).toBe(SAMPLE_IDS.requestId)
    expect(err.fields).toEqual({
      orgId: SAMPLE_IDS.orgId,
      yakId: SAMPLE_IDS.yakId,
    })
  })
})

const MEMBER_ROLES = ["owner", "admin", "member"] as const
const Actor = Schema.Struct({
  kind: Schema.Literals(["user", "service"]),
  linearUserId: Schema.optional(Schema.String),
  role: Schema.optional(Schema.Literals(MEMBER_ROLES)),
})
const S0 = Schema.Struct({ orgId: OrgId, actor: Actor, f0: Schema.String })
const S1 = Schema.Struct({ orgId: OrgId, actor: Actor, f1: Schema.String })
const S2 = Schema.Struct({ orgId: OrgId, actor: Actor, f2: Schema.String })
const S3 = Schema.Struct({ orgId: OrgId, actor: Actor, f3: Schema.String })
const S4 = Schema.Struct({ orgId: OrgId, actor: Actor, f4: Schema.String })
const S5 = Schema.Struct({ orgId: OrgId, actor: Actor, f5: Schema.String })
const S6 = Schema.Struct({ orgId: OrgId, actor: Actor, f6: Schema.String })
const S7 = Schema.Struct({ orgId: OrgId, actor: Actor, f7: Schema.String })
const S8 = Schema.Struct({ orgId: OrgId, actor: Actor, f8: Schema.String })
const S9 = Schema.Struct({ orgId: OrgId, actor: Actor, f9: Schema.String })
const S10 = Schema.Struct({ orgId: OrgId, actor: Actor, f10: Schema.String })
const S11 = Schema.Struct({ orgId: OrgId, actor: Actor, f11: Schema.String })
const S12 = Schema.Struct({ orgId: OrgId, actor: Actor, f12: Schema.String })
const S13 = Schema.Struct({ orgId: OrgId, actor: Actor, f13: Schema.String })
const S14 = Schema.Struct({ orgId: OrgId, actor: Actor, f14: Schema.String })
const S15 = Schema.Struct({ orgId: OrgId, actor: Actor, f15: Schema.String })
const S16 = Schema.Struct({ orgId: OrgId, actor: Actor, f16: Schema.String })
const S17 = Schema.Struct({ orgId: OrgId, actor: Actor, f17: Schema.String })
const S18 = Schema.Struct({ orgId: OrgId, actor: Actor, f18: Schema.String })
const S19 = Schema.Struct({ orgId: OrgId, actor: Actor, f19: Schema.String })

type LargeServiceRpc = {
  readonly m0: HeraRpcMethod<typeof S0, { readonly v: 0 }>
  readonly m1: HeraRpcMethod<typeof S1, { readonly v: 1 }>
  readonly m2: HeraRpcMethod<typeof S2, { readonly v: 2 }>
  readonly m3: HeraRpcMethod<typeof S3, { readonly v: 3 }>
  readonly m4: HeraRpcMethod<typeof S4, { readonly v: 4 }>
  readonly m5: HeraRpcMethod<typeof S5, { readonly v: 5 }>
  readonly m6: HeraRpcMethod<typeof S6, { readonly v: 6 }>
  readonly m7: HeraRpcMethod<typeof S7, { readonly v: 7 }>
  readonly m8: HeraRpcMethod<typeof S8, { readonly v: 8 }>
  readonly m9: HeraRpcMethod<typeof S9, { readonly v: 9 }>
  readonly m10: HeraRpcMethod<typeof S10, { readonly v: 10 }>
  readonly m11: HeraRpcMethod<typeof S11, { readonly v: 11 }>
  readonly m12: HeraRpcMethod<typeof S12, { readonly v: 12 }>
  readonly m13: HeraRpcMethod<typeof S13, { readonly v: 13 }>
  readonly m14: HeraRpcMethod<typeof S14, { readonly v: 14 }>
  readonly m15: HeraRpcMethod<typeof S15, { readonly v: 15 }>
  readonly m16: HeraRpcMethod<typeof S16, { readonly v: 16 }>
  readonly m17: HeraRpcMethod<typeof S17, { readonly v: 17 }>
  readonly m18: HeraRpcMethod<typeof S18, { readonly v: 18 }>
  readonly m19: HeraRpcMethod<typeof S19, { readonly v: 19 }>
}

type LargeServiceClient = HeraRpcClient<LargeServiceRpc>

export function makeLargeThunkClient(binding: LargeServiceRpc): LargeServiceClient {
  return Hera.rpcClient(() => binding, {
    service: "notebook",
    onTransportError: ({ method, retryable, errorName }) => {
      void method
      void retryable
      void errorName
    },
  })
}

describe("Hera.rpcClient over a workerd RPC stub", () => {
  // A workerd service-binding stub answers every property with another remote stub, so
  // `stub.submit.apply` is a remote method named "apply", not `Function.prototype.apply`. The fake
  // reproduces that: any property of the method is a function that rejects like workerd does.
  function workerdStub(impl: (input: unknown) => Promise<unknown>) {
    const method = new Proxy(impl, {
      get: (_target, prop) => () =>
        Promise.reject(new TypeError(`The RPC receiver does not implement the method "${String(prop)}".`)),
    })
    return new Proxy({}, { get: (_t, prop) => (prop === "submit" ? method : undefined) }) as {
      submit: (input: unknown) => Promise<unknown>
    }
  }

  it("invokes the stub's method itself, never a property of it", async () => {
    const stub = workerdStub(async (input) => ({ ok: true, value: { echoed: input } }))
    const client = Hera.rpcClient(() => stub, { service: "notebook" })
    const out = await Effect.runPromise(client.submit({ a: 1 }))
    expect(out).toEqual({ echoed: { a: 1 } })
  })

  // admits: When a service has >= 17 distinct Schema.Struct RPC inputs and Hera.rpcClient(() => binding) is returned as an aliased HeraRpcClient<Service>, non-distributive T[K] conditionals in HeraRpcClient<T>.call intersect all parameter tuples into a 2^N cross-product union that fails with TS2590 and cannot dispatch .call(method, input); no ast-grep rule can evaluate TypeScript's cross-product union limit.
  it("infers Hera.rpcClient(() => binding) and dispatches .call across >= 17 distinct input schemas without TS2590", async () => {
    const fakeBinding = new Proxy(
      {},
      {
        get: (_target, prop) => async (input: Record<string, unknown>) => ({
          ok: true,
          value: { v: Number(String(prop).slice(1)), echoed: input[`f${String(prop).slice(1)}`] },
        }),
      }
    ) as LargeServiceRpc

    const client = makeLargeThunkClient(fakeBinding)
    const viaDirect = await Effect.runPromise(
      client.m17({ orgId: SAMPLE_IDS.orgId, actor: { kind: "service" }, f17: "seventeen" })
    )
    const viaCall = await Effect.runPromise(
      client.call("m19", { orgId: SAMPLE_IDS.orgId, actor: { kind: "service" }, f19: "nineteen" })
    )
    expect(viaDirect).toEqual({ v: 17, echoed: "seventeen" })
    expect(viaCall).toEqual({ v: 19, echoed: "nineteen" })
  })
})
