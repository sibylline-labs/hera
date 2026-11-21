import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * HeraCache on workerd: one cache held per isolate, read by concurrent requests. Each request is its
 * own workerd I/O context. A request resumed from another request's lookup keeps running in that
 * request's context, so its later I/O dies with it and the runtime cancels it as hung.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-cache")

const calls: string[] = []
let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  const build = spawnSync(
    "bun",
    ["build", join(import.meta.dirname, "fixture", "cache-worker.ts"), "--outdir", outDir, "--target", "browser", "--format", "esm", "--external", "cloudflare:workers"],
    { cwd: repoRoot, encoding: "utf8" },
  )
  expect(build.status, build.stderr).toBe(0)
  mf = new Miniflare({
    modules: true,
    scriptPath: join(outDir, "cache-worker.js"),
    compatibilityDate: "2026-07-01",
    outboundService: async (request) => {
      const url = new URL(request.url)
      const key = url.pathname.slice(1)
      if (url.hostname === "after.test") {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return new Response("after")
      }
      calls.push(key)
      await new Promise((resolve) => setTimeout(resolve, 300))
      return new Response(`${key}#${calls.filter((c) => c === key).length}`)
    },
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

const get = async (query: string) => {
  const res = await mf!.dispatchFetch(`http://cache/get?${query}`, { signal: AbortSignal.timeout(8_000) })
  return { status: res.status, body: res.ok ? ((await res.json()) as { value: string }).value : await res.text() }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("HeraCache on workerd", () => {
  // admits: integration: a request that joins another request's in-flight lookup is resumed in that request's
  // I/O context, and its next fetch dies with it ("code had hung"); only workerd's per-request contexts show it
  test("overlapping requests that miss one key, then fetch again, all answer", async () => {
    const pending = []
    for (let i = 0; i < 4; i++) {
      pending.push(get("key=overlap&then=1"))
      await sleep(50)
    }
    const got = await Promise.all(pending)
    for (const g of got) expect(g).toMatchObject({ status: 200, body: expect.stringMatching(/^overlap#[1-4]$/) })
  }, 20_000)

  // admits: integration: a settled answer is served to a later request from the held value, with no lookup of its own
  test("a request after the lookup settled answers from the held value", async () => {
    const first = await get("key=held&then=1")
    const later = await get("key=held&then=1")
    expect([first, later]).toEqual([1, 2].map(() => ({ status: 200, body: "held#1" })))
    expect(calls.filter((c) => c === "held")).toHaveLength(1)
  }, 20_000)
})
