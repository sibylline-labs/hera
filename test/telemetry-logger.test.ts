import * as Effect from "effect/Effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createHeraLogger, type LogEntry } from "../src/core/logger/index.js"
import { attr, logsOf, makeTelemetryHarness } from "./telemetry-helpers.js"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Hera logger hand-off to an exporting invocation", () => {
  // admits: a line double-shipped through console and OTLP, or lost from both; runtime routing
  test("a line inside the invocation exports as an OTLP record and skips the console sink", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const h = makeTelemetryHarness()
    const logger = createHeraLogger({ service: "svc" })
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(
      inv.provide(logger.error("payment.failed", { amount: 3, authorization: "Bearer abc.def" }).pipe(Effect.withSpan("op")))
    )
    inv.end({ status: 200 })
    await h.settle()
    expect(error).not.toHaveBeenCalled()
    const record = logsOf(h.posts.find((p) => p.path === "/v1/logs"))[0]!
    expect(record.severityText).toBe("ERROR")
    expect(record.body).toEqual({ stringValue: "payment.failed" })
    expect(attr(record, "amount")).toBe("3")
    expect(attr(record, "authorization")).toBe("[REDACTED]")
    expect(attr(record, "service")).toBe("svc")
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/)
  })

  // admits: suppression leaking outside an invocation; runtime routing
  test("outside an invocation the console sink still writes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await Effect.runPromise(createHeraLogger({ service: "svc" }).error("payment.failed"))
    expect(error).toHaveBeenCalledTimes(1)
  })

  // admits: a consumer that tees on purpose losing its copy; runtime routing
  test("a custom sink made to tee keeps receiving lines inside an invocation", async () => {
    const lines: Array<LogEntry> = []
    const h = makeTelemetryHarness()
    const logger = createHeraLogger({ service: "svc", sink: (_line, entry) => void lines.push(entry), teeSinkWhenCaptured: true })
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(logger.warn("w")))
    inv.end()
    await h.settle()
    expect(lines).toHaveLength(1)
    expect(logsOf(h.posts[0])).toHaveLength(1)
  })
})
