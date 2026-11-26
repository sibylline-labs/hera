import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * HTTP over Service Binding JS RPC on real workerd (cloudflare/workerd#8674). A raw `Request` with a
 * body crosses RPC as a stream plus a `StreamCanceler`; with the caller still holding `waitUntil`,
 * workerd cancels the callee as hung after it answered. `httpRpcMethod` / `httpRpcClient` send
 * structured-clone envelopes, so the callee's invocation ends `ok`. A tail consumer reports each
 * callee outcome, which no caller can see.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-http-rpc")
const CALLS = 3

let mf: Miniflare | undefined
const outcomes: Array<string> = []

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
  const callee = bundle("http-rpc-callee")
  const caller = bundle("http-rpc-caller")
  const tail = bundle("http-rpc-tail")
  mf = new Miniflare({
    workers: [
      {
        name: "caller",
        modules: true,
        scriptPath: caller,
        compatibilityDate: "2026-07-01",
        serviceBindings: { API: { name: "callee", entrypoint: "HttpApi" } },
      },
      { name: "callee", modules: true, scriptPath: callee, compatibilityDate: "2026-07-01", tails: ["tail"] },
      {
        name: "tail",
        modules: true,
        scriptPath: tail,
        compatibilityDate: "2026-07-01",
        serviceBindings: {
          SINK: async (request) => {
            const params = new URL(request.url).searchParams
            outcomes.push(`${params.get("rpc")}:${params.get("outcome")}`)
            return new Response(null, { status: 204 })
          },
        },
      },
    ],
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

async function settledOutcomes(rpc: string, expected: number): Promise<ReadonlyArray<string>> {
  const deadline = Date.now() + 10_000
  const matching = () => outcomes.filter((o) => o.startsWith(`${rpc}:`))
  while (matching().length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return matching()
}

describe("HTTP over RPC on workerd", () => {
  // admits: integration: only workerd's RPC stream serialisation over a real service binding shows the #8674 cancel; no type or in-process double does
  test("POST with a JSON body and caller waitUntil: the reply body arrives and every callee invocation ends ok", async () => {
    for (let i = 0; i < CALLS; i++) {
      const response = await mf!.dispatchFetch("http://caller/envelope")
      const text = await response.text()
      expect(response.status, text).toBe(201)
      expect(response.headers.get("x-api")).toBe("1")
      expect(JSON.parse(text)).toEqual({ echoed: { probe: true, n: 7 }, method: "POST" })
    }
    expect(await settledOutcomes("handle", CALLS)).toEqual(Array.from({ length: CALLS }, () => "handle:ok"))
  }, 30_000)

  // admits: integration: the control proves the tail read can see a cancelled callee, so the ok above is not vacuous.
  // Fails once workerd stops cancelling a raw unread Request body: then the envelope is no longer required for this shape.
  test("control: a raw Request whose body the callee never reads is cancelled", async () => {
    for (let i = 0; i < CALLS; i++) {
      const response = await mf!.dispatchFetch("http://caller/raw")
      expect(response.status).toBe(200)
      await response.text()
    }
    const raw = await settledOutcomes("rawHandle", CALLS)
    expect(raw).toHaveLength(CALLS)
    expect(raw.filter((o) => o !== "rawHandle:ok")).toHaveLength(CALLS)
  }, 30_000)
})
