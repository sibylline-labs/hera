import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

/**
 * HeraTelemetry on real workerd: tail promotion, waitUntil export, external trace isolation, and
 * the Hera.worker guard keeping raw exception text off workerd's stdio (the runtime log backstop).
 */
const repoRoot = join(import.meta.dirname, "..", "..")
const outDir = join(repoRoot, "data", "scratch", "workerd-telemetry")
const SECRET = "ghp" + "_" + "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xYz123"
const CALLER_TRACE = "e".repeat(32)

interface Post {
  readonly path: string
  readonly body: Record<string, unknown>
}

const posts: Array<Post> = []
let stdio = ""
let mf: Miniflare | undefined

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  const build = spawnSync(
    "bun",
    ["build", join(import.meta.dirname, "fixture", "telemetry-worker.ts"), "--outdir", outDir, "--target", "browser",
      "--format", "esm", "--external", "cloudflare:workers"],
    { cwd: repoRoot, encoding: "utf8" },
  )
  expect(build.status, build.stderr).toBe(0)
  mf = new Miniflare({
    modules: true,
    scriptPath: join(outDir, "telemetry-worker.js"),
    compatibilityDate: "2026-07-01",
    outboundService: async (request) => {
      posts.push({ path: new URL(request.url).pathname, body: (await request.json()) as Record<string, unknown> })
      return new Response("{}", { status: 200 })
    },
    handleRuntimeStdio(stdout, stderr) {
      stdout.on("data", (chunk) => (stdio += String(chunk)))
      stderr.on("data", (chunk) => (stdio += String(chunk)))
    },
  })
  await mf.ready
}, 30_000)

afterAll(async () => {
  await mf?.dispose()
})

/** The posts one request caused, after its waitUntil export settled. */
async function call(path: string, headers: Record<string, string> = {}): Promise<{ status: number; posts: ReadonlyArray<Post> }> {
  const before = posts.length
  const response = await mf!.dispatchFetch(`http://worker${path}`, { headers })
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 400))
  return { status: response.status, posts: posts.slice(before) }
}

type Json = Record<string, unknown>
const spans = (ps: ReadonlyArray<Post>): ReadonlyArray<Json> =>
  ps.filter((p) => p.path === "/v1/traces").flatMap((p) =>
    ((p.body.resourceSpans as Array<Json>)[0]!.scopeSpans as Array<Json>)[0]!.spans as Array<Json>)
const logs = (ps: ReadonlyArray<Post>): ReadonlyArray<Json> =>
  ps.filter((p) => p.path === "/v1/logs").flatMap((p) =>
    ((p.body.resourceLogs as Array<Json>)[0]!.scopeLogs as Array<Json>)[0]!.logRecords as Array<Json>)
const attr = (record: Json, key: string): unknown =>
  Object.values((record.attributes as Array<{ key: string; value: Json }>).find((a) => a.key === key)?.value ?? {})[0]

describe("HeraTelemetry on workerd", () => {
  // admits: billing for healthy traffic; only workerd shows the waitUntil export path
  test("(a) a healthy unsampled fast request posts nothing", async () => {
    const { status, posts: sent } = await call("/healthy")
    expect(status).toBe(200)
    expect(sent).toEqual([])
  })

  // admits: a routine warn promoting the buffer; only workerd shows the waitUntil export path
  test("(b) a warn posts its own record and no spans", async () => {
    const { posts: sent } = await call("/warn")
    expect(spans(sent)).toEqual([])
    expect(logs(sent).map((r) => r.severityText)).toEqual(["WARN"])
  })

  // admits: a failing or slow invocation losing its buffer; only workerd shows the waitUntil export path
  test.each(["/error", "/5xx", "/die", "/slow"])("(c) %s promotes spans and info records", async (path) => {
    const { posts: sent } = await call(path)
    expect(spans(sent).map((s) => s.name).sort()).toEqual([`GET ${path}`, "inner"].sort())
    expect(logs(sent).some((r) => r.severityText === "INFO")).toBe(true)
  }, 10_000)

  // admits: a real V8 stack exported with raw line 1 or no fingerprint; only workerd emits V8 frames
  test("(c) the error span carries the fingerprint and a redacted V8 stack", async () => {
    const { posts: sent } = await call("/die")
    const span = spans(sent).find((s) => s.name === "GET /die")!
    expect(attr(span, "logfire.exception.fingerprint")).toMatch(/^[0-9a-f]{16}$/)
    const event = (span.events as Array<Json>).find((e) => e.name === "exception")!
    const stack = String(attr(event, "exception.stacktrace"))
    expect(stack.split("\n")[0]).toBe("TypeError: [REDACTED]")
    expect(stack.split("\n").length).toBeGreaterThan(1)
    expect(JSON.stringify(sent)).not.toContain(SECRET)
  })

  // admits: an external caller choosing the trace id or forcing sampled=1; only a real request carries the header
  test("(d) an external traceparent with sampled=1 is ignored", async () => {
    const healthy = await call("/healthy", { traceparent: `00-${CALLER_TRACE}-${"f".repeat(16)}-01` })
    expect(healthy.posts).toEqual([])
    const failing = await call("/error", { traceparent: `00-${CALLER_TRACE}-${"f".repeat(16)}-01` })
    expect(spans(failing.posts).length).toBeGreaterThan(0)
    expect(spans(failing.posts).map((s) => s.traceId)).not.toContain(CALLER_TRACE)
  })

  // admits: a raw exception message reaching workerd's log backstop; only workerd stdio shows it
  test("a throwing handler and a rejected waitUntil stay inside Hera, scrubbed", async () => {
    const thrown = await call("/throw")
    expect(thrown.status).toBe(503)
    const rejected = await call("/wait-reject")
    expect(rejected.status).toBe(200)
    expect(stdio).toContain("hera.worker.defect")
    expect(stdio).toContain("hera.worker.wait_until_rejected")
    expect(stdio).not.toContain(SECRET)
    // Lines written inside an exporting invocation left through OTLP only, never the console too.
    expect(stdio).not.toContain('"msg":"broke"')
    expect(stdio).not.toContain('"msg":"routine.warn"')
    expect(JSON.stringify(posts)).not.toContain(SECRET)
  })
})
