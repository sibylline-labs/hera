import * as Effect from "effect/Effect"
import { describe, expect, test } from "vitest"
import { createHeraLogger, Hera, HeraBoundaryDefect, type HeraMigration, type LogEntry } from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"
import { GITLEAKS_FIXTURES } from "./fixtures/gitleaks-secrets.js"
import { attr, logsOf, makeTelemetryHarness, spansOf } from "./telemetry-helpers.js"

const SECRET = GITLEAKS_FIXTURES["github-pat"]!
const CALLER_TP = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`

describe("route boundaries open and end an invocation", () => {
  const route = Hera.publicRoute({
    method: "GET",
    path: "/x",
    service: "svc",
    handler: () => createHeraLogger({ service: "svc" }).info("route.ran").pipe(Effect.as({ ok: true })),
  })

  // admits: a hooked route exporting nothing for a 5xx, or a public caller picking the trace; runtime wiring
  test("trace internal parents under the caller's traceparent; external does not", async () => {
    for (const trace of ["internal", "external"] as const) {
      const h = makeTelemetryHarness()
      const res = await route(new Request("https://svc.test/x", { headers: { traceparent: CALLER_TP } }), {
        telemetry: h,
        trace,
      })
      expect(res.status).toBe(200)
      await h.settle()
      const traced = h.posts.some((p) => spansOf(p).some((s) => s.traceId === "c".repeat(32)))
      expect(traced).toBe(trace === "internal")
    }
  })

  // admits: a dying handler leaking its message or exporting without a fingerprint; runtime wiring
  test("a dying handler answers 503 and exports a fingerprinted error span", async () => {
    const h = makeTelemetryHarness()
    const dies = Hera.publicRoute({
      method: "GET",
      path: "/d",
      handler: () => Effect.sync(() => {
        throw new Error(`db said ${SECRET}`)
      }),
    })
    const res = await dies(new Request("https://svc.test/d"), { telemetry: h })
    expect(res.status).toBe(503)
    await h.settle()
    const span = spansOf(h.posts.find((p) => p.path === "/v1/traces")).find((s) => s.name === "GET /d")!
    expect(attr(span, "logfire.exception.fingerprint")).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(h.posts)).not.toContain(SECRET)
  })
})

describe("rpcMethod and queueConsumer", () => {
  // admits: an RPC hop exporting under a fresh trace instead of the caller's; runtime wiring
  test("rpcMethod with a hook exports under the caller's trace on a 503", async () => {
    const h = makeTelemetryHarness()
    const method = Hera.rpcMethod({
      name: "m",
      service: "callee",
      telemetry: h,
      handler: () => Effect.die(new Error("nope")),
    })
    const result = await method(undefined, { traceparent: CALLER_TP } as never)
    expect(result.ok).toBe(false)
    await h.settle()
    const spans = spansOf(h.posts.find((p) => p.path === "/v1/traces"))
    expect(spans.map((s) => s.traceId)).toContain("c".repeat(32))
  })

  // admits: queue batches never exporting their warn/error records; runtime wiring
  test("queueConsumer exports a warn from its handler through ctx.waitUntil", async () => {
    const h = makeTelemetryHarness()
    const consumer = Hera.queueConsumer({
      name: "q",
      telemetry: h.telemetry,
      handler: () => createHeraLogger({ service: "q" }).warn("queue.slowish"),
    })
    const messages = [{ id: "m1", timestamp: new Date(), attempts: 1, body: {}, ack() {}, retry() {} }]
    await consumer({ queue: "q", messages, ackAll() {}, retryAll() {} }, {}, { waitUntil: h.waitUntil })
    await h.settle()
    expect(logsOf(h.posts[0]).map((r) => r.body)).toEqual([{ stringValue: "queue.slowish" }])
  })
})

describe("Hera.worker guard", () => {
  const lines: Array<LogEntry> = []
  const sink = (_line: string, entry: LogEntry) => void lines.push(entry)

  // admits: a raw exception message reaching the runtime's log backstop; only a run shows the boundary
  test("a throwing fetch answers 503 problem+json and logs no raw text", async () => {
    const guarded = Hera.worker({ fetch: (_r: Request, _e: unknown, _c: unknown): Response => { throw new Error(`token ${SECRET}`) } }, { service: "w", sink })
    const pending: Array<Promise<unknown>> = []
    const res = await guarded.fetch!(new Request("https://w.test/"), {}, { waitUntil: (p: Promise<unknown>) => void pending.push(p) })
    expect(res.status).toBe(503)
    expect(res.headers.get("content-type")).toContain("application/problem+json")
    expect(JSON.stringify(lines)).not.toContain(SECRET)
    expect(lines.at(-1)?.event).toBe("hera.worker.defect")
  })

  // admits: a rejected waitUntil escaping as an unhandled rejection with its raw message; runtime
  test("a rejected waitUntil is caught and logged scrubbed", async () => {
    const pending: Array<Promise<unknown>> = []
    const guarded = Hera.worker(
      {
        fetch: (_r: Request, _e: unknown, ctx: { waitUntil(p: Promise<unknown>): void }) => {
          ctx.waitUntil(Promise.reject(new TypeError(`late ${SECRET}`)))
          return new Response("ok")
        },
      },
      { service: "w", sink }
    )
    await guarded.fetch!(new Request("https://w.test/"), {}, { waitUntil: (p: Promise<unknown>) => void pending.push(p) })
    await Promise.all(pending)
    expect(lines.at(-1)?.event).toBe("hera.worker.wait_until_rejected")
    expect(lines.at(-1)?.defect_name).toBe("TypeError")
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })

  // admits: a caller-shaped `_tag` reaching the backstop line as the defect name; runtime text
  test("a thrown object's secret-shaped _tag is not logged", async () => {
    const guarded = Hera.worker(
      { fetch: (_r: Request, _e: unknown, _c: unknown): Response => { throw { _tag: SECRET } } },
      { service: "w", sink }
    )
    await guarded.fetch!(new Request("https://w.test/"), {}, { waitUntil() {} })
    expect(lines.at(-1)?.event).toBe("hera.worker.defect")
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })

  // admits: a queue defect swallowed (losing the retry) or rethrown raw; runtime
  test("a throwing queue handler rethrows a fixed-message HeraBoundaryDefect", async () => {
    const guarded = Hera.worker({ queue: () => { throw new Error(`q ${SECRET}`) } }, { service: "w", sink })
    const error = await (guarded.queue as (b: unknown, e: unknown, c: unknown) => Promise<void>)({}, {}, { waitUntil() {} }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HeraBoundaryDefect)
    expect(String((error as Error).message)).not.toContain(SECRET)
  })
})

describe("DO alarm boundary", () => {
  const MIGRATIONS: ReadonlyArray<HeraMigration> = [{ version: 1, name: "001_t", sql: "CREATE TABLE t (id TEXT PRIMARY KEY)" }]

  // admits: an alarm defect reaching workerd raw, or the alarm retry lost; runtime
  test("a rejected alarm pass is logged scrubbed and rethrown sanitized", async () => {
    const lines: Array<LogEntry> = []
    class Dying extends Hera.TenantDurableObject.configure({ service: "dying", migrations: MIGRATIONS }) {
      protected override runAlarmProgram(): Promise<void> {
        return Promise.reject(new Error(`alarm ${SECRET}`))
      }
    }
    const harness = makeTestDurableObjectState({ initialTimeMs: 1_700_000_000_000 })
    const object = new Dying(harness.state, {}, { sink: (_l, e) => void lines.push(e) })
    await object.runWithTenantCtx(object.scheduleDomainAlarm(1_700_000_000_000))
    const error = await object.alarm().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HeraBoundaryDefect)
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })
})
