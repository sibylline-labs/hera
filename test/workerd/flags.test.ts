import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { ORG_A, ORG_B, targeted } from "../fixtures/ofrep"

/**
 * HeraFlags.ofrep on workerd: a Worker reads a flag per org through the real runtime's
 * fetch, against the OFREP fixture served by Miniflare's outbound service.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-flags")
const TOKEN = "pylf_v1_us_WORKERDTESTTOKEN"

interface Seen {
  readonly url: string
  readonly authorization: string | null
  readonly context: Record<string, unknown>
}
const seen: Seen[] = []
let down = false
let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  const build = spawnSync(
    "bun",
    ["build", join(import.meta.dirname, "fixture", "flags-worker.ts"), "--outdir", outDir, "--target", "browser", "--format", "esm", "--external", "cloudflare:workers"],
    { cwd: repoRoot, encoding: "utf8" },
  )
  expect(build.status, build.stderr).toBe(0)
  mf = new Miniflare({
    modules: true,
    scriptPath: join(outDir, "flags-worker.js"),
    compatibilityDate: "2026-07-01",
    bindings: { LOGFIRE_READ_TOKEN: TOKEN },
    outboundService: async (request) => {
      // An endpoint that never answers: the reader's 250ms timeout is the unreachable path
      // (a thrown error here reaches the Worker as a 500, not a transport failure).
      if (down) await new Promise((resolve) => setTimeout(resolve, 2_000))
      const body = (await request.json()) as { context: Record<string, unknown> }
      seen.push({ url: request.url, authorization: [...request.headers].find(([k]) => k === "authorization")?.[1] ?? null, context: body.context })
      const answer = targeted(String(body.context.org_id))
      return new Response(answer.body, { status: 200, headers: { "content-type": "application/json", etag: answer.etag } })
    },
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

const read = async (org: string) =>
  (await (await mf!.dispatchFetch(`http://flags/?org=${org}`)).json()) as {
    value: boolean
    warns: { msg: string; reason: string; flag: string }[]
  }

describe("HeraFlags.ofrep on workerd", () => {
  // admits: only the runtime shows the reader's fetch, body and bearer leave a Worker as Logfire expects
  test("answers the targeted value for a matching org and the default for another", async () => {
    expect(await read(ORG_A)).toEqual({ value: true, warns: [] })
    expect(await read(ORG_B)).toEqual({ value: false, warns: [] })
    expect(seen.map((s) => [s.url, s.authorization, s.context.targetingKey, s.context.org_id])).toEqual([
      ["https://logfire.test/v1/ofrep/v1/evaluate/flags", `Bearer ${TOKEN}`, ORG_A, ORG_A],
      ["https://logfire.test/v1/ofrep/v1/evaluate/flags", `Bearer ${TOKEN}`, ORG_B, ORG_B],
    ])
  })

  // admits: a transport failure that throws out of the Worker, or a fallback that logs nothing
  test("an unreachable endpoint answers the fallback with one warn line and no throw", async () => {
    down = true
    try {
      const got = await read(ORG_A)
      expect(got.value).toBe(false)
      expect(got.warns).toHaveLength(1)
      expect(got.warns[0]).toMatchObject({ msg: "hera.flags.fallback", flag: "hera_ofrep_probe", reason: "unreachable" })
      expect(JSON.stringify(got)).not.toContain(TOKEN)
    } finally {
      down = false
    }
  })
})
