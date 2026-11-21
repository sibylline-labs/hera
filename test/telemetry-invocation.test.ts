import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { afterEach, describe, expect, test, vi } from "vitest"
import { HeraConfigError } from "../src/core/config/types.js"
import { HeraError } from "../src/core/errors/index.js"
import { HeraTelemetry } from "../src/core/telemetry/index.js"
import { attr, logsOf, makeTelemetryHarness, spansOf } from "./telemetry-helpers.js"

const EXTERNAL_TP = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`

const work = Effect.logInfo("step").pipe(Effect.withSpan("child"), Effect.withSpan("root"))

afterEach(() => {
  vi.restoreAllMocks()
})

describe("HeraTelemetry config", () => {
  // admits: a credential sent to a default host; config is runtime env data
  test("a token without baseUrl is refused", () => {
    expect(() =>
      HeraTelemetry.make({ service: "svc", environment: "test", sink: { token: Redacted.make("t") } })
    ).toThrow(HeraConfigError)
  })

  // admits: a silent tokenless boot or a warn per request; runtime behaviour
  test("no token warns hera.telemetry.unconfigured once and never posts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const h = makeTelemetryHarness({ sink: {} })
    expect(h.telemetry.configured).toBe(false)
    for (let i = 0; i < 3; i++) {
      const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
      await Effect.runPromise(inv.provide(Effect.logError("boom")))
      inv.end({ status: 500 })
    }
    await h.settle()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(warn.mock.calls[0]?.[0])).event).toBe("hera.telemetry.unconfigured")
    expect(h.posts).toEqual([])
  })

  // admits: I/O at construction; runtime behaviour
  test("make and begin do no I/O", () => {
    const h = makeTelemetryHarness()
    h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    expect(h.posts).toEqual([])
  })
})

describe("tail promotion", () => {
  // admits: billing for healthy traffic; the promotion decision is runtime
  test("(a) a healthy, fast, unsampled invocation posts nothing", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(work))
    inv.end({ status: 200 })
    await h.settle()
    expect(h.posts).toEqual([])
  })

  // admits: a routine warn promoting the buffer; runtime decision
  test("(b) a warn posts its own record and promotes nothing", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(work.pipe(Effect.andThen(Effect.logWarning("routine")))))
    inv.end({ status: 200 })
    await h.settle()
    expect(h.posts.map((p) => p.path)).toEqual(["/v1/logs"])
    expect(logsOf(h.posts[0]).map((r) => r.severityText)).toEqual(["WARN"])
    expect(h.posts[0]?.headers.get("authorization")).toBe("write-token")
  })

  // admits: a failing invocation exporting nothing; runtime decision
  test.each([
    ["an error log", Effect.logError("bad"), {}],
    ["a 5xx", Effect.void, { status: 503 }],
    ["a defect", Effect.void, { defect: true }],
  ] as const)("(c) %s promotes spans and info records", async (_label, extra, outcome) => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(work.pipe(Effect.andThen(extra))))
    inv.end(outcome)
    await h.settle()
    const traces = h.posts.find((p) => p.path === "/v1/traces")
    expect(spansOf(traces).map((s) => s.name)).toEqual(["child", "root"])
    const logs = logsOf(h.posts.find((p) => p.path === "/v1/logs"))
    expect(logs.some((r) => r.severityText === "INFO")).toBe(true)
  })

  // admits: a slow invocation missed; clock-driven
  test("(c) a slow invocation promotes", async () => {
    let now = 0
    const h = makeTelemetryHarness({ now: () => now })
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(work))
    now = 1_001
    inv.end({ status: 200 })
    await h.settle()
    expect(h.posts.map((p) => p.path).sort()).toEqual(["/v1/logs", "/v1/traces"])
  })

  // admits: an error span without fingerprint or with raw line 1; runtime text
  test("(c) a dying span carries the exception event and fingerprint, line 1 redacted", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    const dies = Effect.sync(() => {
      throw new TypeError("leaky detail")
    }).pipe(Effect.withSpan("dies"))
    await Effect.runPromiseExit(inv.provide(dies))
    inv.end({ defect: true })
    await h.settle()
    const span = spansOf(h.posts.find((p) => p.path === "/v1/traces"))[0]!
    expect(span.status).toEqual({ code: 2, message: "TypeError" })
    expect(attr(span, "logfire.exception.fingerprint")).toMatch(/^[0-9a-f]{16}$/)
    const event = (span.events as ReadonlyArray<Record<string, unknown>>).find((e) => e.name === "exception")!
    expect(attr(event, "exception.message")).toBe("[REDACTED]")
    expect(String(attr(event, "exception.stacktrace")).split("\n")[0]).toBe("TypeError: [REDACTED]")
    expect(JSON.stringify(h.posts)).not.toContain("leaky detail")
  })

  // admits: caller refusals opening Logfire issues; runtime classification
  test("a catalogued 4xx records error.code and does not promote", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    const refused = Effect.fail(
      new HeraError({ code: "not_found", httpStatus: 404, publicMessage: "Not found", requestId: "req_x" as never })
    ).pipe(Effect.withSpan("refuses"))
    await Effect.runPromiseExit(inv.provide(refused))
    inv.end({ status: 404 })
    await h.settle()
    expect(h.posts).toEqual([])
  })

  // admits: unbounded buffering (Gate-0 48/32); runtime count
  test("the span ring keeps the newest 48 and reports the rest dropped", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(Effect.forEach(Array.from({ length: 60 }, (_, i) => i), (i) => Effect.withSpan(Effect.void, `s${i}`))))
    inv.end({ status: 500 })
    await h.settle()
    const spans = spansOf(h.posts.find((p) => p.path === "/v1/traces"))
    expect(spans).toHaveLength(48)
    expect(spans[0]?.name).toBe("s12")
    expect(h.reports.find((r) => r.signal === "traces")?.dropped).toBe(12)
  })

  // admits: a guard and a boundary both ending double-export; runtime state
  test("end is idempotent", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(Effect.logWarning("w")))
    inv.end()
    inv.end({ status: 500 })
    await h.settle()
    expect(h.posts).toHaveLength(1)
  })
})

describe("trace context", () => {
  // admits: an external caller choosing trace id or forcing sampled=1 (D4); runtime header
  test("(d) source external ignores a caller traceparent with sampled=1", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "external", traceparent: EXTERNAL_TP, waitUntil: h.waitUntil })
    expect(inv.sampled).toBe(false)
    await Effect.runPromise(inv.provide(work))
    inv.end({ status: 500 })
    await h.settle()
    const spans = spansOf(h.posts.find((p) => p.path === "/v1/traces"))
    expect(spans.map((s) => s.traceId)).not.toContain("a".repeat(32))
    expect(spans.find((s) => s.name === "root")?.parentSpanId).toBeUndefined()
  })

  // admits: a trusted parent ignored; runtime header
  test("source internal parents under the traceparent and follows its sampled flag", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "internal", traceparent: EXTERNAL_TP, waitUntil: h.waitUntil })
    expect(inv.sampled).toBe(true)
    await Effect.runPromise(inv.provide(work))
    inv.end({ status: 200 })
    await h.settle()
    const root = spansOf(h.posts.find((p) => p.path === "/v1/traces")).find((s) => s.name === "root")
    expect(root?.traceId).toBe("a".repeat(32))
    expect(root?.parentSpanId).toBe("b".repeat(16))
  })

  // admits: head sampling never exporting; runtime decision
  test("a root head-sampled below headRate exports without promotion", async () => {
    const h = makeTelemetryHarness({ random: () => 0.001 })
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(work))
    inv.end({ status: 200 })
    await h.settle()
    expect(h.posts.map((p) => p.path).sort()).toEqual(["/v1/logs", "/v1/traces"])
  })
})

describe("export transport", () => {
  // admits: a 530 counted as sent; runtime status
  test("any non-2xx (workerd's 530) is rejected, never sent", async () => {
    const h = makeTelemetryHarness({ status: 530 })
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(Effect.logWarning("w")))
    inv.end()
    await h.settle()
    expect(h.reports.map((r) => r.outcome)).toEqual(["rejected"])
  })

  // admits: missing deployment.environment.name (PRD contract); runtime payload
  test("resource carries service, environment, version and the sdk name", async () => {
    const h = makeTelemetryHarness()
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(Effect.logWarning("w")))
    inv.end()
    await h.settle()
    const resource = ((h.posts[0]?.body.resourceLogs as ReadonlyArray<Record<string, unknown>>)[0]?.resource ?? {}) as Record<string, unknown>
    expect(attr(resource, "service.name")).toBe("svc")
    expect(attr(resource, "deployment.environment.name")).toBe("test")
    expect(attr(resource, "service.version")).toBe("v1")
    expect(attr(resource, "telemetry.sdk.name")).toBe("@sibylline-labs/hera")
  })
})
