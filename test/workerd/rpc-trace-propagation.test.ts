import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * One trace and one request id across Caller Worker -> Callee WorkerEntrypoint -> tenant DO ->
 * outbox -> queue -> Hera.queueConsumer, on real workerd RPC stubs and a real queue.
 * Only workerd shows whether the appended invoke meta survives a service binding and a DO stub.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-trace")
const REQUEST_ID = "req_01JAW4B8X7H2M9Q5R8T3V6Y1Z0"
const ORG_ID = "org_01JAW4B8X7H2M9Q5R8T3V6Y1Z0"
const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/

let mf: Miniflare | undefined

function bundle(name: string): string {
  const build = spawnSync(
    "bun",
    ["build", join(import.meta.dirname, "fixture", `${name}.ts`), "--outdir", outDir, "--target", "browser",
      "--format", "esm", "--external", "cloudflare:workers"],
    { cwd: repoRoot, encoding: "utf8" },
  )
  expect(build.status, build.stderr).toBe(0)
  return join(outDir, `${name}.js`)
}

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  const callee = bundle("trace-callee")
  const caller = bundle("trace-caller")
  mf = new Miniflare({
    workers: [
      {
        name: "caller",
        modules: true,
        scriptPath: caller,
        compatibilityDate: "2026-07-01",
        serviceBindings: { CALLEE: { name: "callee", entrypoint: "Callee" } },
      },
      {
        name: "callee",
        modules: true,
        scriptPath: callee,
        compatibilityDate: "2026-07-01",
        durableObjects: { LEDGER: { className: "Ledger", useSQLite: true } },
        queueProducers: { EVENTS: { queueName: "ledger-events" } },
        queueConsumers: { "ledger-events": { maxBatchTimeout: 1 } },
      },
    ],
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

interface Hop {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly requestId: string
}

describe("RPC and outbox trace propagation on workerd", () => {
  // admits: the meta crosses real workerd service-binding and DO-stub RPC and a real queue; no type or in-process double observes that
  test("Caller -> Callee -> tenant DO -> outbox queue keeps one traceId and one requestId", async () => {
    const response = await mf!.dispatchFetch("http://caller/")
    const text = await response.text()
    expect(response.status, text).toBe(200)
    const body = JSON.parse(text) as {
      readonly traceId: string
      // `Hera.rpcClient` unwraps each hop's `{ ok: true, value }` envelope.
      readonly callee: Hop & {
        readonly log: Record<string, unknown> | null
        readonly ledger: Hop & { readonly outbox: { readonly traceparent: string | null; readonly requestId: string | null } }
      }
    }
    const callee = body.callee
    const ledger = callee.ledger

    // RPC hops parent under the previous hop and share the caller's traceId.
    expect(callee.traceId).toBe(body.traceId)
    expect(ledger.traceId).toBe(body.traceId)
    expect(callee.parentSpanId).not.toBeNull()
    expect(ledger.parentSpanId).not.toBeNull()
    expect(ledger.parentSpanId).not.toBe(callee.spanId) // the DO parents under the callee's client span

    // Request id and the caller's org reach the callee without explicit correlation args.
    expect(callee.requestId).toBe(REQUEST_ID)
    expect(ledger.requestId).toBe(REQUEST_ID)
    expect(callee.log?.request_id).toBe(REQUEST_ID)
    expect(callee.log?.org_id).toBe(ORG_ID)
    expect(callee.log?.trace_id).toBe(body.traceId)

    // The outbox row records the DO span and the caller's request id.
    const match = TP.exec(ledger.outbox.traceparent ?? "")
    expect(match?.[1]).toBe(body.traceId)
    expect(match?.[2]).toBe(ledger.spanId)
    expect(ledger.outbox.requestId).toBe(REQUEST_ID)

    // The queue consumer links to the producer trace and sees the caller's request id.
    const deadline = Date.now() + 10_000
    let consumed: ReadonlyArray<{
      readonly linkTraceIds: ReadonlyArray<string>
      readonly messages: ReadonlyArray<{ readonly body: unknown; readonly requestId: string | null }>
    }> = []
    while (consumed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      consumed = (await (await mf!.dispatchFetch("http://caller/consumed")).json()) as typeof consumed
    }
    expect(consumed.length).toBeGreaterThan(0)
    expect(consumed[0]?.linkTraceIds).toEqual([body.traceId])
    expect(consumed[0]?.messages).toEqual([{ body: { n: 1 }, requestId: REQUEST_ID }])
  }, 30_000)
})
