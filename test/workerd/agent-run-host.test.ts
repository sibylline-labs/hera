import { mkdirSync } from "node:fs"
import { builtinModules } from "node:module"
import { join } from "node:path"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * A run-keyed `Hera.agent` on workerd: one Durable Object per `org:<OrgId>:run:<runKey>`. Only
 * workerd gives each name its own SQLite, runs Lifecycle's alarm after `ctx.abort`, and resets an
 * object on `purgeStorage()`, so the isolation, eviction and purge claims are proven here.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-agent-run")
const DEADLINE_MS = 20_000
const ORG = "01ARZ3NDEKTSV4RRFFQ69G5FC1"
const run = (key: string) => `org:${ORG}:run:${key}`

type Observed = {
  readonly orgId: string
  readonly runKey: string | null
  readonly incarnation: string
  readonly tables: ReadonlyArray<string>
  readonly pending: ReadonlyArray<string>
  readonly sideEffects: ReadonlyArray<string>
  readonly meterOperations: ReadonlyArray<string | null>
  readonly alarm: number | null
}
type Receipt = { readonly operationId: string; readonly session: string; readonly accepted: boolean }

let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  // The same esbuild settings as the per-org agent suite (wrangler's workerd bundle shape).
  await build({
    entryPoints: [join(import.meta.dirname, "fixture", "agent-run-worker.ts")],
    outfile: join(outDir, "agent-run-worker.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:*", ...builtinModules],
    logLevel: "error",
  })
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: join(outDir, "agent-run-worker.js") }],
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      RUN: { className: "RunAgent", useSQLite: true },
      ORG: { className: "OrgAgent", useSQLite: true },
    },
    outboundService: () => new Response("unexpected egress", { status: 599 }),
  })
  await mf.ready
}, 60_000)

afterAll(async () => {
  await mf?.dispose()
})

async function call<T>(name: string, op: string, extra = ""): Promise<T> {
  const response = await mf!.dispatchFetch(`http://run/?name=${encodeURIComponent(name)}&op=${op}${extra}`)
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
const settled = (o: Observed) => o.pending.length === 0 && o.sideEffects.length > 0

describe("a run-keyed Hera.agent on workerd", () => {
  // admits: boundary-io: two runs of one org sharing one object's SQLite, meter or Pi state; or orgId/runKey read from anything but the name.
  test("two run keys of one org get separate objects and storage", async () => {
    const [a, b] = [run("resolve:epic-a:1"), run("resolve:epic-a:2")]
    await call<Receipt>(a, "start", "&operation=op-a")
    await call<Receipt>(b, "start", "&operation=op-b")
    const [oa, ob] = [await until(a, settled), await until(b, settled)]

    expect([oa.orgId, oa.runKey]).toEqual([ORG, "resolve:epic-a:1"])
    expect([ob.orgId, ob.runKey]).toEqual([ORG, "resolve:epic-a:2"])
    expect(oa.incarnation).not.toBe(ob.incarnation)
    expect(new Set(oa.meterOperations)).toEqual(new Set(["op-a"]))
    expect(new Set(ob.meterOperations)).toEqual(new Set(["op-b"]))
    expect(oa.sideEffects).toEqual(["call_0_0"])
    expect(ob.sideEffects).toEqual(["call_0_0"])
  }, 30_000)

  // admits: boundary-io: an eviction stranding a run-keyed run, i.e. the alarm path not resuming it with no request.
  test("a run resumes on its alarm after a forced eviction", async () => {
    const name = run("resolve:epic-b:1")
    const receipt = await call<Receipt>(name, "start", "&operation=op-evict")
    expect(receipt.accepted).toBe(true)
    const first = (await call<Observed>(name, "observe")).incarnation
    await sleep(250)
    await call(name, "evict") // mid generation 1

    // No requests from here: only the alarm can resume the run.
    await sleep(4_000)
    const after = await until(name, settled)
    expect(after.incarnation).not.toBe(first)
    expect(after.pending).toEqual([])
    expect(after.sideEffects).toEqual(["call_0_0"])
    expect(after.meterOperations.length).toBeGreaterThanOrEqual(2)
    expect(await call(name, "wait", `&operation=op-evict&session=${receipt.session}`)).toEqual({ status: "done", text: "alpha=v" })
  }, 40_000)

  // admits: boundary-io: purgeStorage on one run reaching another run's object of the same org.
  test("purgeStorage on one run leaves the other intact", async () => {
    const [gone, kept] = [run("resolve:epic-c:1"), run("resolve:epic-c:2")]
    await call(gone, "start", "&operation=op-gone")
    await call(kept, "start", "&operation=op-kept")
    await until(gone, settled)
    const before = await until(kept, settled)

    await call(gone, "purge")
    await sleep(1_000)
    const purged = await call<Observed>(gone, "observe")
    expect(purged.tables.filter((t) => t.startsWith("pi_") || t.startsWith("cf_agents") || t.startsWith("_hera"))).toEqual([])
    expect(purged.alarm).toBeNull()

    const intact = await call<Observed>(kept, "observe")
    expect(intact.incarnation).toBe(before.incarnation)
    expect(intact.tables).toEqual(before.tables)
    expect(intact.sideEffects).toEqual(["call_0_0"])
    expect(intact.meterOperations).toEqual(before.meterOperations)
  }, 30_000)

  // admits: boundary-io: cancel not reaching a run-keyed object's in-flight operation.
  test("cancel stops an in-flight run", async () => {
    const name = run("resolve:epic-d:1")
    const receipt = await call<Receipt>(name, "start", "&operation=op-cancel")
    expect(await call(name, "cancel", "&operation=op-cancel")).toEqual({ cancelled: true })
    const outcome = await call<{ status: string }>(name, "wait", `&operation=op-cancel&session=${receipt.session}`)
    expect(outcome.status).toBe("unanswered")
  }, 30_000)

  // admits: boundary-io: a run-keyed class accepting a per-org (or malformed) name, or a per-org class accepting a run name.
  test("each form refuses the other's name in its constructor", async () => {
    const refused = "Durable Object instance does not have a valid tenant OrgId identity"
    for (const name of [`org:${ORG}`, ORG, `org:${ORG}:run:`, `org:not-an-org:run:k`, `org:${ORG}:run:has space`]) {
      expect(await call(name, "identity"), name).toEqual({ error: expect.stringContaining(refused) })
    }
    // The longest run key the parser admits still names a workerd object.
    const longest = "k".repeat(256)
    expect(await call(run(longest), "identity")).toEqual({ ok: expect.objectContaining({ orgId: ORG, runKey: longest }) })
    const org = await mf!.dispatchFetch(`http://run/?ns=org&name=${encodeURIComponent(`org:${ORG}`)}`)
    expect(await org.json()).toEqual({ ok: { orgId: ORG, runKey: null } })
    const crossed = await mf!.dispatchFetch(`http://run/?ns=org&name=${encodeURIComponent(run("k"))}`)
    expect(await crossed.json()).toEqual({ error: expect.stringContaining(refused) })
  }, 30_000)
})
