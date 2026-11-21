import { mkdirSync } from "node:fs"
import { builtinModules } from "node:module"
import { join } from "node:path"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * `Hera.agent` on workerd: Pi Durable hosted on a `TenantDurableObject`, a scripted model
 * served through the egress seam, and Hera's composite pass as a Lifecycle host job. Only workerd
 * runs Lifecycle's alarm dispatch and `ctx.abort`, so evictions and purge are proven here.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-agent")
const DEADLINE_MS = 20_000

type Observed = {
  readonly tables: ReadonlyArray<string>
  readonly pending: ReadonlyArray<string>
  readonly toolExec: ReadonlyArray<{ readonly call_id: string; readonly n: number }>
  readonly sideEffects: ReadonlyArray<string>
  readonly toolResults: ReadonlyArray<{ readonly id: string; readonly isError: boolean }>
  readonly meter: ReadonlyArray<string>
  readonly meterOperations: ReadonlyArray<string | null>
  readonly toolOps: ReadonlyArray<{ readonly session: string; readonly callId: string; readonly operationId: string | null }>
  readonly purgeEvents: ReadonlyArray<string>
  readonly incarnation: string
  readonly taskTraceIds: ReadonlyArray<string>
  readonly alarm: number | null
}

type ExportedSpan = {
  readonly name: string
  readonly traceId: string
  readonly service: string
  readonly environment: string
  readonly attributes: Readonly<Record<string, string>>
  readonly events: ReadonlyArray<string>
  readonly spanId: string
  readonly parentSpanId: string | undefined
}
type OtlpKeyValue = { readonly key: string; readonly value: { readonly stringValue?: string } }
const spans: ExportedSpan[] = []
/** Parent ids among `among` that no exported span carries: an orphan in Logfire's trace tree. */
const dangling = (among: ReadonlyArray<ExportedSpan>) => {
  const ids = new Set(spans.map((s) => s.spanId))
  return among.flatMap((s) => (s.parentSpanId !== undefined && !ids.has(s.parentSpanId) ? [`${s.name} -> ${s.parentSpanId}`] : []))
}
let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  // esbuild with wrangler's workerd settings: production bundles this way. Bun's bundler wraps
  // pi-ai's cyclic modules in lazy initialisers whose order breaks `observeModelRequest`.
  await build({
    entryPoints: [join(import.meta.dirname, "fixture", "agent-worker.ts")],
    outfile: join(outDir, "agent-worker.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    // `nodejs_compat` serves Node builtins under both spellings, as wrangler leaves them external.
    external: ["cloudflare:workers", "node:*", ...builtinModules],
    logLevel: "error",
  })
  mf = new Miniflare({
    // pi-ai carries a dynamic `import()` helper for Node modules it never reaches on workerd; an
    // explicit module list stops Miniflare walking (and refusing) it.
    modules: [{ type: "ESModule", path: join(outDir, "agent-worker.js") }],
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      ORG: { className: "AgentOrg", useSQLite: true },
      CONTENT: { className: "AgentOrgContent", useSQLite: true },
    },
    // The OTLP sink: every span the agent exports lands here, in the test process.
    outboundService: async (request) => {
      if (new URL(request.url).host === "otlp.test") {
        const body = JSON.parse(await request.text()) as {
          resourceSpans?: Array<{
            resource?: { attributes?: OtlpKeyValue[] }
            scopeSpans?: Array<{
              spans?: Array<{ name: string; traceId: string; spanId: string; parentSpanId?: string; attributes?: OtlpKeyValue[]; events?: Array<{ name: string }> }>
            }>
          }>
        }
        const flat = (kvs: OtlpKeyValue[] | undefined) =>
          Object.fromEntries((kvs ?? []).map((kv) => [kv.key, String(kv.value.stringValue ?? "")]))
        for (const rs of body.resourceSpans ?? []) {
          const resource = flat(rs.resource?.attributes)
          const service = resource["service.name"] ?? ""
          const environment = resource["deployment.environment.name"] ?? ""
          for (const ss of rs.scopeSpans ?? []) {
            for (const s of ss.spans ?? []) {
              spans.push({
                name: s.name,
                traceId: s.traceId,
                service,
                environment,
                attributes: flat(s.attributes),
                events: (s.events ?? []).map((e) => e.name),
                spanId: s.spanId,
                parentSpanId: s.parentSpanId,
              })
            }
          }
        }
        return new Response("{}")
      }
      return new Response("unexpected egress", { status: 599 })
    },
  })
  await mf.ready
}, 60_000)

afterAll(async () => {
  await mf?.dispose()
})

async function call<T>(name: string, op: string, extra = ""): Promise<T> {
  const response = await mf!.dispatchFetch(`http://agent/?name=${encodeURIComponent(name)}&op=${op}${extra}`)
  const body = await response.text()
  expect(response.status, body).toBe(200)
  return JSON.parse(body) as T
}

async function until(name: string, done: (o: Observed) => boolean): Promise<Observed> {
  const deadline = Date.now() + DEADLINE_MS
  let last = await call<Observed>(name, "observe")
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    last = await call<Observed>(name, "observe")
  }
  return last
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("Hera.agent on workerd", () => {
  // admits: an eviction stranding the run, a replay repeating a side effect, or a restart starting a new trace.
  test("settles through three forced evictions: one side effect per callId, one trace id", async () => {
    const name = "org:01ARZ3NDEKTSV4RRFFQ69G5FB1"
    const receipt = await call<{ accepted: boolean }>(name, "start", "&script=chaos&operation=op-chaos")
    expect(receipt.accepted).toBe(true)
    const incarnations = new Set([(await call<Observed>(name, "observe")).incarnation])

    await sleep(250)
    await call(name, "evict") // mid generation 1
    incarnations.add((await until(name, (o) => o.toolExec.length > 0)).incarnation)
    await sleep(150)
    await call(name, "evict") // mid tool call
    incarnations.add((await until(name, (o) => o.sideEffects.length > 0)).incarnation)
    await sleep(250)
    await call(name, "evict") // mid generation 2

    // No requests from here: only the alarm can resume the run.
    await sleep(4_000)
    const settled = await until(name, (o) => o.pending.length === 0)
    incarnations.add(settled.incarnation)
    expect(incarnations.size).toBe(4) // the first object plus one per eviction
    expect(settled.pending).toEqual([])
    // The contract is at-least-once execution of a replay-safe tool under one stable callId, so a
    // handler keyed on callId writes its effect once. An eviction mid-call reruns the handler
    // (n can be 2); what must hold is one callId across every execution and one effect row.
    expect(settled.toolExec.map((t) => t.call_id)).toEqual(["call_0_0"])
    expect(settled.toolExec[0]?.n).toBeGreaterThanOrEqual(1)
    expect(settled.sideEffects).toEqual(["call_0_0"])
    expect(settled.toolResults).toEqual([{ id: "call_0_0", isError: false }])
    expect(settled.meter.length).toBeGreaterThanOrEqual(2)

    // generation 1, the tool call and generation 2 each ran as a Pi task, across the evictions,
    // all under the submission's one trace; every span exported for the run is in it.
    expect(settled.taskTraceIds.length).toBeGreaterThanOrEqual(3)
    const runTrace = settled.taskTraceIds[0]
    expect(new Set(settled.taskTraceIds)).toEqual(new Set([runTrace]))
    const exported = spans.filter((s) => /^(chat|execute_tool) /.test(s.name))
    expect(exported.length).toBeGreaterThanOrEqual(1)
    expect(new Set(exported.map((s) => s.traceId))).toEqual(new Set([runTrace]))
    expect(dangling(exported)).toEqual([])
    // Real pi-ai output: the GenAI attributes Logfire's Agents view reads, the environment on every
    // batch, and none of Pi's per-block events (pi-ai emits one per completed content block).
    const chats = exported.filter((s) => s.name.startsWith("chat "))
    expect(chats.length).toBeGreaterThanOrEqual(1)
    for (const chat of chats) expect(chat.attributes["gen_ai.operation.name"]).toBe("chat")
    for (const span of spans) expect(span.environment).toBe("workerd-test")
    expect(spans.flatMap((s) => s.events).filter((name) => name === "pi.ai.block")).toEqual([])
    expect(chats.some((s) => "first_chunk_latency_ms" in s.attributes)).toBe(true)
  }, 60_000)

  // admits: a tool or meter row attributed to "the latest running run" instead of its own operation.
  test("two operations at once on one host each see their own operationId in the tool and on the meter", async () => {
    const name = "org:01ARZ3NDEKTSV4RRFFQ69G5FB4"
    const receipts = await call<{ a: { operationId: string; session: string }; b: { operationId: string; session: string } }>(
      name, "startTwo", "&a=op-a&b=op-b"
    )
    expect(receipts.a.session).not.toBe(receipts.b.session)
    const settled = await until(name, (o) => o.pending.length === 0 && o.toolOps.length >= 2 && o.meterOperations.length >= 4)
    expect(settled.toolOps.map((t) => [t.session, t.operationId])).toEqual(
      [[receipts.a.session, "op-a"], [receipts.b.session, "op-b"]].sort((x, y) => String(x[0]).localeCompare(String(y[0])))
    )
    expect([...settled.meterOperations].sort()).toEqual(["op-a", "op-a", "op-b", "op-b"])
  }, 30_000)

  // admits: Pi's coercion ({key:3} -> "3") reaching the handler on the real runtime.
  test("rejects a coerced tool input before the handler runs", async () => {
    const name = "org:01ARZ3NDEKTSV4RRFFQ69G5FB2"
    await call(name, "start", "&script=coerced&operation=op-coerced")
    const settled = await until(name, (o) => o.pending.length === 0 && o.toolResults.length > 0)
    expect(settled.toolResults).toEqual([{ id: "call_0_0", isError: true }])
    expect(settled.toolExec).toEqual([])
    expect(settled.sideEffects).toEqual([])
  }, 30_000)

  // admits: a live harness writing to dropped tables, or a purge that leaves Pi or Hera state behind.
  test("purges in the order dispose -> deleteAll -> abort, leaving no pi_* tables or alarm", async () => {
    const name = "org:01ARZ3NDEKTSV4RRFFQ69G5FB3"
    await call(name, "start", "&script=chaos&operation=op-purge")
    await until(name, (o) => o.tables.some((t) => t.startsWith("pi_")))
    await call(name, "purge")
    await sleep(1_500)
    const after = await call<Observed>(name, "observe")
    expect(after.purgeEvents).toEqual(["dispose", "deleteAll", "abort"])
    expect(after.tables.filter((t) => t.startsWith("pi_") || t.startsWith("cf_agents") || t.startsWith("_hera"))).toEqual([])
    expect(after.alarm).toBeNull()
  }, 30_000)

  // admits: content missing on a contentExport object's spans or leaking from a metadata-only one, or a run-level parent in another run's trace; only a real Pi run on workerd reaches both seams.
  test("contentExport puts content on chat and execute_tool spans; the default object's spans carry none", async () => {
    const name = "org:01ARZ3NDEKTSV4RRFFQ69G5FB5"
    const receipt = await call<{ session: string }>(name, "start", "&ns=content&operation=op-content")
    const deadline = Date.now() + DEADLINE_MS
    const mine = () => spans.filter((s) => s.service === "workerd-agent-content")
    while (Date.now() < deadline && !(mine().filter((s) => s.name.startsWith("chat ")).length >= 2 && mine().some((s) => s.name.startsWith("execute_tool ")))) {
      await sleep(100)
    }
    const chats = mine().filter((s) => s.name.startsWith("chat "))
    const tool = mine().find((s) => s.name === "execute_tool lookup")
    expect(chats).toHaveLength(2)
    for (const chat of chats) {
      expect(JSON.parse(chat.attributes["gen_ai.system_instructions"] ?? "[]")[0]?.content).toContain("You are a terse test agent.")
      expect(chat.attributes["gen_ai.input.messages"]).toContain("Call lookup with key alpha")
      expect(chat.attributes["gen_ai.output.messages"]).toBeDefined()
    }
    expect(chats.map((c) => c.attributes["gen_ai.output.messages"]).join(" ")).toContain('"tool_call"')
    expect(chats.map((c) => c.attributes["gen_ai.output.messages"]).join(" ")).toContain("alpha=v")
    expect(tool?.attributes["gen_ai.tool.call.arguments"]).toBe('{"key":"alpha"}')
    expect(tool?.attributes["gen_ai.tool.call.result"]).toBe("alpha=v")

    const carrier = await call<{ traceparent: string } | null>(name, "carrier", `&ns=content&session=${receipt.session}`)
    expect(new Set(mine().map((s) => s.traceId))).toEqual(new Set([carrier?.traceparent.split("-")[1]]))
    expect(dangling(mine())).toEqual([])

    const metadataOnly = spans.filter((s) => s.service === "workerd-agent")
    expect(metadataOnly.length).toBeGreaterThan(0)
    const contentKeys = ["gen_ai.system_instructions", "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]
    for (const span of metadataOnly) for (const key of contentKeys) expect(span.attributes[key], `${span.name} ${key}`).toBeUndefined()
  }, 30_000)
})
