import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * Workers RPC on a `TenantDurableObject.configure(...)` subclass, observed on workerd.
 * The vitest suite runs Hera's DO against a stub `cloudflare:workers` base, which cannot show
 * whether workerd accepts the class as an RPC target; this lane bundles a real Worker and asks it.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-smoke")
const orgName = "org:01ARZ3NDEKTSV4RRFFQ69G5FAV"

let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  const build = spawnSync(
    "bun",
    [
      "build",
      join(import.meta.dirname, "fixture", "worker.ts"),
      "--outdir",
      outDir,
      "--target",
      "browser",
      "--format",
      "esm",
      "--external",
      "cloudflare:workers",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  )
  expect(build.status, build.stderr).toBe(0)
  mf = new Miniflare({
    modules: true,
    scriptPath: join(outDir, "worker.js"),
    compatibilityDate: "2026-07-01",
    durableObjects: { ORG: { className: "Org", useSQLite: true } },
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

describe("TenantDurableObject on workerd", () => {
  // admits: an RPC read on a configure() subclass running the DDL eagerly on real workerd; only the runtime observes construction order
  test("a read-only RPC call on a configure() subclass returns a value and initialises no storage", async () => {
    const response = await mf!.dispatchFetch(`http://smoke/?name=${encodeURIComponent(orgName)}`)
    const body = await response.text()

    expect(response.status, body).toBe(200)
    expect(JSON.parse(body)).toEqual({
      orgId: orgName.slice("org:".length),
      service: "workerd-smoke",
      migrations: [],
    })
  })
})
