import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * `HeraHttp.sse` through `Hera.publicRoute` on workerd, the runtime the writer's consumers deploy to.
 * workerd does not cancel a response body when the client disconnects; it aborts `request.signal`,
 * and only with the `enable_request_signal` compatibility flag, so the fixture passes
 * `disconnect: request.signal`.
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-sse")

let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  const build = spawnSync(
    "bun",
    [
      "build",
      join(import.meta.dirname, "fixture", "sse-worker.ts"),
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
    scriptPath: join(outDir, "sse-worker.js"),
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["enable_request_signal"],
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

async function status(): Promise<{ readonly signalAborted: boolean; readonly outcome: string }> {
  const res = await mf!.dispatchFetch("http://smoke/status")
  return ((await res.json()) as { data: { signalAborted: boolean; outcome: string } }).data
}

describe("HeraHttp.sse on workerd", () => {
  // admits: streaming after the handler returned, workerd timers driving keepalives, and a client
  // disconnect reaching the source; only the runtime shows any of them.
  test("streams frames and keepalives, and a client disconnect aborts the source's signal", async () => {
    const client = new AbortController()
    const response = await mf!.dispatchFetch("http://smoke/sse", { signal: client.signal })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-request-id")).toBeTruthy()

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ""
    while (!text.includes(": queued\n\n")) {
      const { value, done } = await reader.read()
      expect(done).toBe(false)
      text += decoder.decode(value)
    }
    expect(text.startsWith('data: {"id":"c1","delta":"hello"}\n\n')).toBe(true)
    expect(await status()).toEqual({ signalAborted: false, outcome: "open" })

    await reader.cancel().catch(() => {})
    client.abort()
    await expect.poll(status, { timeout: 5_000, interval: 50 }).toEqual({ signalAborted: true, outcome: "cancelled" })
  })
})
