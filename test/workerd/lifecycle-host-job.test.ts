import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * Hera's composite pass as an `agents` `Lifecycle` host job, observed on workerd. A
 * `TenantDurableObject` whose `AlarmDriver` keeps one Lifecycle host job runs its outbox, named jobs
 * and domain slot from that job, while Lifecycle owns the platform alarm. The node suite runs the
 * same seam against a recording driver, but only workerd shows Lifecycle's dispatch and outcome
 * handling. Lifecycle needs `nodejs_compat`, so the bundle keeps `node:*` external.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-lifecycle")
const POLL_DEADLINE_MS = 10_000

type Observed = {
  readonly initialized: boolean
  readonly seen: ReadonlyArray<string>
  readonly hookRetryGapMs: number | null
  readonly pending: number
  readonly heraTables: ReadonlyArray<string>
  readonly compositeJobAt: number | null
  readonly platformAlarm: number | null
}

let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  const build = spawnSync(
    "bun",
    [
      "build",
      join(import.meta.dirname, "fixture", "lifecycle-worker.ts"),
      "--outdir",
      outDir,
      "--target",
      "browser",
      "--format",
      "esm",
      "--external",
      "cloudflare:workers",
      "--external",
      "node:*",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  )
  expect(build.status, build.stderr).toBe(0)
  mf = new Miniflare({
    modules: true,
    scriptPath: join(outDir, "lifecycle-worker.js"),
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ORG: { className: "LifecycleOrg", useSQLite: true } },
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

async function call<T>(name: string, op: string): Promise<T> {
  const response = await mf!.dispatchFetch(`http://lifecycle/?name=${encodeURIComponent(name)}&op=${op}`)
  const body = await response.text()
  expect(response.status, body).toBe(200)
  return JSON.parse(body) as T
}

async function observeUntil(name: string, done: (o: Observed) => boolean): Promise<Observed> {
  const deadline = Date.now() + POLL_DEADLINE_MS
  let last = await call<Observed>(name, "observe")
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    last = await call<Observed>(name, "observe")
  }
  return last
}

describe("the composite pass as a Lifecycle host job on workerd", () => {
  // admits: two alarm owners clobber each other, or the invariants break under a host job; only workerd runs Lifecycle's dispatch
  test("drains the outbox, runs the named job, and re-runs a failed domain hook after the backoff", async () => {
    const name = "org:01ARZ3NDEKTSV4RRFFQ69G5FAV"
    await call(name, "seed")
    const seeded = await call<Observed>(name, "observe")
    expect(seeded.compositeJobAt).not.toBeNull()
    expect(seeded.platformAlarm).not.toBeNull()

    const settled = await observeUntil(name, (o) => o.seen.includes("hook"))
    expect(settled.seen).toEqual(
      expect.arrayContaining(["delivered:evt_1", "job", "hook-failed", "hook"])
    )
    expect(settled.seen.indexOf("hook-failed")).toBeLessThan(settled.seen.indexOf("hook"))
    // The fixture's backoff is 200 ms; workerd's clock is coarse, so allow a little under it.
    expect(settled.hookRetryGapMs).toBeGreaterThanOrEqual(150)
    expect(settled.pending).toBe(0)
    // Nothing left pending: the host job completed rather than rescheduling.
    expect(settled.compositeJobAt).toBeNull()
  }, 20_000)

  // admits: a pass writes Hera state after storage was purged under it; runtime state across an await
  test("touches nothing after a deleteAll during the pass", async () => {
    const name = "org:01ARZ3NDEKTSV4RRFFQ69G5FAW"
    await call(name, "seedPurgeMidPass")
    const purged = await observeUntil(name, (o) => !o.initialized && o.compositeJobAt === null)
    expect(purged.initialized).toBe(false)
    expect(purged.heraTables).toEqual([])
    // deleteAll drops Lifecycle's job table too, so the proof is that nothing re-armed afterwards.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const later = await call<Observed>(name, "observe")
    expect(later.platformAlarm).toBeNull()
    expect(later.heraTables).toEqual([])
  }, 20_000)

  // admits: a purge door's RPC is rejected by its own reset, or leaves a wake behind; only workerd runs ctx.abort
  test("purgeStorage over RPC resolves, then the next call reaches an empty object with no alarm", async () => {
    const name = "org:01ARZ3NDEKTSV4RRFFQ69G5FAX"
    await call(name, "seed")
    expect((await call<Observed>(name, "observe")).heraTables.length).toBeGreaterThan(0)

    await call(name, "purge")
    await new Promise((resolve) => setTimeout(resolve, 200))
    const after = await call<Observed>(name, "observe")
    expect(after.initialized).toBe(false)
    expect(after.heraTables).toEqual([])
    expect(after.compositeJobAt).toBeNull()
    expect(after.platformAlarm).toBeNull()
  }, 20_000)
})
