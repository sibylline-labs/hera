import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * A WebSocket upgrade returned from `Hera.publicRoute`, observed on workerd. The boundary
 * used to rebuild every returned `Response`, which drops the `webSocket` of a 101 and made the
 * runtime answer 500 "Web Socket request did not return status 101".
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-upgrade")

let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  const build = spawnSync(
    "bun",
    [
      "build",
      join(import.meta.dirname, "fixture", "upgrade-worker.ts"),
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
    scriptPath: join(outDir, "upgrade-worker.js"),
    compatibilityDate: "2026-07-01",
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

function nextMessage(socket: { addEventListener: (type: "message", fn: (event: { data: unknown }) => void) => void }) {
  return new Promise<string>((resolve) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)))
  })
}

describe("Hera.publicRoute on workerd", () => {
  // admits: only the runtime shows that a 101 Response keeps its socket through the route boundary
  test("a route returning an upgrade Response completes the handshake and frames flow both ways", async () => {
    const response = await mf!.dispatchFetch("http://smoke/ws", { headers: { upgrade: "websocket" } })

    expect(response.status).toBe(101)
    const socket = response.webSocket
    expect(socket).not.toBeNull()
    const ready = nextMessage(socket!)
    socket!.accept()
    expect(await ready).toBe("ready")
    const echoed = nextMessage(socket!)
    socket!.send("ping")
    expect(await echoed).toBe("echo:ping")
    socket!.close()
  })

  // admits: header values on a runtime Response
  test("a non-upgrade response keeps cache-control and x-request-id", async () => {
    const response = await mf!.dispatchFetch("http://smoke/plain")

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-request-id")).toBeTruthy()
  })
})
