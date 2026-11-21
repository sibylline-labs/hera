import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * An authority-guarded `Hera.authedRoute` on workerd, the runtime guarded routes deploy to: the
 * grant reaches the handler, refusals render 403 problem+json with the verifier's slug, a missing
 * credential refuses, and a credential the verifier echoes never reaches the wire.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-authority")
const ECHOED = "opaque_cred_9f1c2e7d4b"

let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  const build = spawnSync(
    "bun",
    [
      "build",
      join(import.meta.dirname, "fixture", "authority-worker.ts"),
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
    scriptPath: join(outDir, "authority-worker.js"),
    compatibilityDate: "2026-07-01",
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

async function skip(grant: string | undefined): Promise<{ readonly status: number; readonly type: string | null; readonly body: Record<string, unknown>; readonly raw: string }> {
  const res = await mf!.dispatchFetch("http://smoke/skip/plan-review", {
    method: "POST",
    headers: grant === undefined ? {} : { "x-grant": grant },
  })
  const raw = await res.text()
  return { status: res.status, type: res.headers.get("content-type"), body: JSON.parse(raw) as Record<string, unknown>, raw }
}

describe("authority-guarded Hera.authedRoute on workerd", () => {
  // admits: boundary-io — the guarded route's grant, refusal and redaction paths through a real
  // workerd isolate, where the bundled Effect runtime and Response serialisation are the deployed ones.
  test("passes the grant to the handler and refuses with 403 problem+json otherwise", async () => {
    const granted = await skip("good")
    expect(granted.status).toBe(200)
    expect(granted.body.data).toEqual({ grant: "grant-for-plan-review", verb: "gate:skip" })

    const stale = await skip("stale")
    expect(stale.status).toBe(403)
    expect(stale.type).toContain("application/problem+json")
    expect(stale.body).toMatchObject({ type: "urn:hera:error:forbidden", code: "forbidden", slug: "grant-expired" })

    const missing = await skip(undefined)
    expect(missing.status).toBe(403)
    expect(missing.body).toMatchObject({ code: "forbidden", slug: "authority-credential-missing" })

    const echoed = await skip(ECHOED)
    expect(echoed.status).toBe(403)
    expect(echoed.body).toMatchObject({ slug: "grant-unknown", what: "no grant matches [REDACTED]" })
    expect(echoed.raw).not.toContain(ECHOED)
  })
})
