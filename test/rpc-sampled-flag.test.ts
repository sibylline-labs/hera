import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { buildAmbientRpcMeta } from "../src/server/rpc/invoke-meta.js"
import { makeTelemetryHarness } from "./telemetry-helpers.js"

const SAMPLED_TP = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`
const flagOf = (traceparent: string | undefined) => traceparent?.slice(-2)

describe("the sampled flag an rpc call carries", () => {
  // admits: Effect's default tracer marks every span sampled, forcing callees to export under a span nobody exports; runtime tracer
  it("is 00 under a span no exporting invocation captures", async () => {
    const meta = await Effect.runPromise(buildAmbientRpcMeta.pipe(Effect.withSpan("detached")))
    expect(meta.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/)
  })

  // admits: the guard silencing a sampled invocation's propagation; runtime decision
  it("follows the invocation's decision inside one", async () => {
    const sampled = makeTelemetryHarness({ sampling: { headRate: 1 } })
    const unsampled = makeTelemetryHarness({ random: () => 0.99 })
    const read = (h: ReturnType<typeof makeTelemetryHarness>) => {
      const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
      return Effect.runPromise(inv.provide(buildAmbientRpcMeta.pipe(Effect.withSpan("op"))))
    }
    expect(flagOf((await read(sampled)).traceparent)).toBe("01")
    expect(flagOf((await read(unsampled)).traceparent)).toBe("00")
  })

  // admits: a sampled remote parent forwarded with no local span losing its flag; runtime context
  it("keeps a sampled remote parent's flag when no local span is open", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "internal", traceparent: SAMPLED_TP, waitUntil: h.waitUntil })
    const meta = await Effect.runPromise(inv.provide(buildAmbientRpcMeta))
    expect(meta.traceparent).toBe(SAMPLED_TP)
  })
})
