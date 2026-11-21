import * as Effect from "effect/Effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createHeraLogger, type LogEntry } from "../src/core/logger/index.js"
import { HeraTelemetry } from "../src/core/telemetry/index.js"
import { logsOf, makeTelemetryHarness, spansOf, type Posted } from "./telemetry-helpers.js"

type Json = Record<string, unknown>

const UNSAMPLED_TP = `00-${"a".repeat(32)}-${"b".repeat(16)}-00`
const SAMPLED_TP = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`

afterEach(() => {
  vi.restoreAllMocks()
})

/** Every span id a parent pointer of `posts` names that `posts` never exported, besides `allowed`. */
function danglingParents(posts: ReadonlyArray<Posted>, allowed: ReadonlyArray<string> = []): ReadonlyArray<string> {
  const spans = posts.filter((p) => p.path === "/v1/traces").flatMap((p) => spansOf(p))
  const logs = posts.filter((p) => p.path === "/v1/logs").flatMap((p) => logsOf(p))
  const exported = new Set([...spans.map((s) => s.spanId as string), ...allowed])
  const pointers = [
    ...spans.map((s: Json) => s.parentSpanId as string | undefined),
    ...logs.map((l: Json) => l.spanId as string | undefined),
  ]
  return pointers.filter((id): id is string => id !== undefined && !exported.has(id))
}

describe("a custom sink under an exporting invocation", () => {
  // admits: a console-filter sink double-shipping every captured line to the runtime's log export; runtime routing
  test("is skipped when the capture took the line", async () => {
    const lines: Array<LogEntry> = []
    const h = makeTelemetryHarness()
    const logger = createHeraLogger({ service: "svc", sink: (_line, entry) => void lines.push(entry) })
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(logger.warn("w")))
    inv.end()
    await h.settle()
    expect(lines).toHaveLength(0)
    expect(logsOf(h.posts[0])).toHaveLength(1)
  })

  // admits: a consumer that tees on purpose losing its copy; runtime routing
  test("keeps writing with teeSinkWhenCaptured, in child loggers too", async () => {
    const lines: Array<LogEntry> = []
    const h = makeTelemetryHarness()
    const logger = createHeraLogger({ service: "svc", sink: (_line, entry) => void lines.push(entry), teeSinkWhenCaptured: true })
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(Effect.andThen(logger.warn("w"), logger.child({ k: 1 }).warn("c"))))
    inv.end()
    await h.settle()
    expect(lines).toHaveLength(2)
    expect(logsOf(h.posts[0])).toHaveLength(2)
  })
})

describe("exported records name only exported parents", () => {
  // admits: an unsampled warn exported alone pointing at its discarded span; the export set is a runtime decision
  test("a warn exported without its spans carries no spanId", async () => {
    const h = makeTelemetryHarness()
    const logger = createHeraLogger({ service: "svc" })
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(logger.warn("lease.failed").pipe(Effect.withSpan("op"))))
    inv.end({ status: 200 })
    await h.settle()
    expect(h.posts.map((p) => p.path)).toEqual(["/v1/logs"])
    const record = logsOf(h.posts[0])[0]!
    expect(record.spanId).toBeUndefined()
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/)
  })

  // admits: the hygiene rule stripping a valid link; runtime decision
  test("a promoted invocation keeps the spanId of a span it exports", async () => {
    const h = makeTelemetryHarness()
    const logger = createHeraLogger({ service: "svc" })
    const inv = h.telemetry.begin({ name: "x", source: "external", waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(logger.error("boom").pipe(Effect.withSpan("op"))))
    inv.end({ status: 200 })
    await h.settle()
    const span = spansOf(h.posts.find((p) => p.path === "/v1/traces"))[0]!
    const record = logsOf(h.posts.find((p) => p.path === "/v1/logs"))[0]!
    expect(record.spanId).toBe(span.spanId)
    expect(danglingParents(h.posts)).toEqual([])
  })

  // admits: a promoted callee pointing at an unsampled caller span nobody exports; runtime decision
  test("a promoted run under an unsampled remote parent drops that parent", async () => {
    const h = makeTelemetryHarness()
    const logger = createHeraLogger({ service: "svc" })
    const inv = h.telemetry.begin({ name: "x", source: "internal", traceparent: UNSAMPLED_TP, waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(Effect.andThen(logger.error("outer"), logger.error("inner").pipe(Effect.withSpan("op")))))
    inv.end({ status: 200 })
    await h.settle()
    const span = spansOf(h.posts.find((p) => p.path === "/v1/traces"))[0]!
    expect(span.traceId).toBe("a".repeat(32))
    expect(span.parentSpanId).toBeUndefined()
    expect(danglingParents(h.posts)).toEqual([])
  })

  // admits: the rule severing a sampled caller, whose span the caller exports; runtime decision
  test("a sampled remote parent stays the parent", async () => {
    const h = makeTelemetryHarness()
    const logger = createHeraLogger({ service: "svc" })
    const inv = h.telemetry.begin({ name: "x", source: "internal", traceparent: SAMPLED_TP, waitUntil: h.waitUntil })
    await Effect.runPromise(inv.provide(Effect.andThen(logger.warn("outer"), Effect.void.pipe(Effect.withSpan("op")))))
    inv.end({ status: 200 })
    await h.settle()
    expect(spansOf(h.posts.find((p) => p.path === "/v1/traces"))[0]!.parentSpanId).toBe("b".repeat(16))
    expect(logsOf(h.posts.find((p) => p.path === "/v1/logs"))[0]!.spanId).toBe("b".repeat(16))
    expect(danglingParents(h.posts, ["b".repeat(16)])).toEqual([])
  })

  // admits: a fresh root inheriting an outer, unsampled invocation's span through the fiber; runtime context
  test("a fresh root run inside another invocation's span starts its own trace", async () => {
    const outer = makeTelemetryHarness({ random: () => 0.99 })
    const inner = makeTelemetryHarness({ sampling: { headRate: 1 } })
    const nested = HeraTelemetry.run(
      inner.telemetry,
      { name: "heartbeat", source: "internal", waitUntil: inner.waitUntil },
      Effect.void.pipe(Effect.withSpan("yak.drain_summary"))
    )
    const outerInv = outer.telemetry.begin({ name: "alarm", source: "internal", waitUntil: outer.waitUntil })
    const outerTrace = await Effect.runPromise(
      outerInv.provide(Effect.andThen(nested, Effect.currentSpan).pipe(Effect.map((s) => s.traceId), Effect.withSpan("alarm")))
    )
    outerInv.end({ status: 200 })
    await Promise.all([outer.settle(), inner.settle()])
    expect(outer.posts).toEqual([])
    const span = spansOf(inner.posts.find((p) => p.path === "/v1/traces"))[0]!
    expect(span.name).toBe("yak.drain_summary")
    expect(span.parentSpanId).toBeUndefined()
    expect(span.traceId).not.toBe(outerTrace)
  })
})
