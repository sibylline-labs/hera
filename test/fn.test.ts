import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import { describe, expect, it } from "vitest"
import { Hera, HeraCtx, HeraError, HeraTenantCtx } from "../src/index"
import {
  SAMPLE_IDS,
  withTestCtx,
  withTestTenantCtx,
} from "../src/testing/index"

function createRecordingTracer() {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const tracerLayer = Layer.succeed(Tracer.Tracer, tracer)
  return { spans, tracer, tracerLayer }
}

describe("Hera.fn — traced functions and generators", () => {
  it("wraps an Effect generator in a named span and records arguments, attributes, and completion status", async () => {
    const { spans, tracerLayer } = createRecordingTracer()

    const computeQuota = Hera.fn("BillingService.computeQuota", {
      attributes: { tier: "enterprise" },
    })(function* (units: number, multiplier: number) {
      const tenant = yield* HeraTenantCtx
      return `${tenant.service}:${units * multiplier}`
    })

    const result = await Effect.runPromise(
      withTestTenantCtx(computeQuota(12, 3), {
        service: "polaris-billing",
        actorKind: "admin",
      }).pipe(Effect.provide(tracerLayer))
    )

    expect(result).toBe("polaris-billing:36")
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.name).toBe("BillingService.computeQuota")
    expect(span.status._tag).toBe("Ended")
    expect(span.attributes.get("tier")).toBe("enterprise")
    expect(span.attributes.get("requestId")).toBe(SAMPLE_IDS.requestId)
    expect(span.attributes.get("request_id")).toBe(SAMPLE_IDS.requestId)
    expect(span.attributes.get("orgId")).toBe(SAMPLE_IDS.orgId)
    expect(span.attributes.get("org_id")).toBe(SAMPLE_IDS.orgId)
    expect(span.attributes.get("actorId")).toBe(SAMPLE_IDS.actorId)
    expect(span.attributes.get("actor_id")).toBe(SAMPLE_IDS.actorId)
    expect(span.attributes.get("actorKind")).toBe("admin")
    expect(span.attributes.get("actor_kind")).toBe("admin")
    expect(span.attributes.get("service")).toBe("polaris-billing")
  })

  it("enriches the span from HeraCtx when HeraTenantCtx is not provided, without requiring HeraCtx in R", async () => {
    const { spans, tracerLayer } = createRecordingTracer()

    // Pure function with R = never
    const addPure = Hera.fn("MathService.add")(function* (
      a: number,
      b: number
    ) {
      return yield* Effect.succeed(a + b)
    })

    // Runs without any HeraCtx / HeraTenantCtx provided (R = never)
    const bareSum = await Effect.runPromise(
      addPure(10, 15).pipe(Effect.provide(tracerLayer))
    )
    expect(bareSum).toBe(25)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.name).toBe("MathService.add")
    expect(spans[0]!.attributes.get("requestId")).toBeUndefined()

    // Runs with HeraCtx provided — automatically enriches span attributes
    const ctxSum = await Effect.runPromise(
      withTestCtx(addPure(20, 22), {
        service: "relay-worker",
        orgId: Option.some(SAMPLE_IDS.orgId),
        actorId: Option.some(SAMPLE_IDS.actorId),
      }).pipe(Effect.provide(tracerLayer))
    )
    expect(ctxSum).toBe(42)
    expect(spans).toHaveLength(2)
    const enrichedSpan = spans[1]!
    expect(enrichedSpan.name).toBe("MathService.add")
    expect(enrichedSpan.attributes.get("service")).toBe("relay-worker")
    expect(enrichedSpan.attributes.get("requestId")).toBe(SAMPLE_IDS.requestId)
    expect(enrichedSpan.attributes.get("orgId")).toBe(SAMPLE_IDS.orgId)
    expect(enrichedSpan.attributes.get("actorId")).toBe(SAMPLE_IDS.actorId)
  })

  it("supports pipeable transforms after the generator body", async () => {
    const { spans, tracerLayer } = createRecordingTracer()

    const doubled = Hera.fn("TransformService.double")(
      function* (n: number) {
        return yield* Effect.succeed(n * 2)
      },
      (eff, n) => Effect.map(eff, (val) => `${n}->${val}`)
    )

    const out = await Effect.runPromise(
      withTestCtx(doubled(7), { service: "pipe-test" }).pipe(
        Effect.provide(tracerLayer)
      )
    )
    expect(out).toBe("7->14")
    expect(spans).toHaveLength(1)
    expect(spans[0]!.attributes.get("service")).toBe("pipe-test")
  })

  it("supports direct (name, fn) overload and enriches span from context", async () => {
    const { spans, tracerLayer } = createRecordingTracer()

    const greet = Hera.fn("Greeter.hello", (target: string) =>
      Effect.map(HeraCtx, (ctx) => `${ctx.service}:hello:${target}`)
    )

    const value = await Effect.runPromise(
      withTestCtx(greet("world"), { service: "direct-svc" }).pipe(
        Effect.provide(tracerLayer)
      )
    )
    expect(value).toBe("direct-svc:hello:world")
    expect(spans).toHaveLength(1)
    expect(spans[0]!.name).toBe("Greeter.hello")
    expect(spans[0]!.attributes.get("service")).toBe("direct-svc")
    expect(spans[0]!.attributes.get("requestId")).toBe(SAMPLE_IDS.requestId)
  })

  it("propagates typed failures and defects with span frame attribution", async () => {
    const { spans, tracerLayer } = createRecordingTracer()

    const failingOp = Hera.fn("OrderService.cancel")(function* (
      orderId: string
    ) {
      return yield* Effect.fail(
        HeraError.notFound(`Order ${orderId} not found`)
      )
    })

    const exit = await Effect.runPromiseExit(
      withTestTenantCtx(failingOp("ord_99"), { service: "orders" }).pipe(
        Effect.provide(tracerLayer)
      )
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const pretty = Cause.pretty(exit.cause)
      expect(pretty).toContain("OrderService.cancel")
    }
    expect(spans).toHaveLength(1)
    expect(spans[0]!.status._tag).toBe("Ended")
    expect(spans[0]!.attributes.get("orgId")).toBe(SAMPLE_IDS.orgId)
  })
})
