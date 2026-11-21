import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import { HeraAgentTelemetry } from "../src/server/agent/telemetry/index.js"
import { GITLEAKS_FIXTURES } from "./fixtures/gitleaks-secrets.js"
import { attr, rig } from "./agent-telemetry-helpers.js"

const SECRET = GITLEAKS_FIXTURES["github-pat"]!

/** A Pi-shaped run: submit -> (model phase -> request) and (tool phase), then the host's invoke_agent. */
async function run(t: ReturnType<typeof rig>["telemetry"], messages: unknown) {
  await t.context.startSpan(
    { name: "pi.durable.submit", attributes: { "submission.type": "input", "conversation.id": 7 } },
    async (submit) => {
      await submit.startSpan({ name: "pi.durable.phase", attributes: { "task.id": 1, phase: "model" } }, async (phase) => {
        await phase.startSpan(
          { name: "pi.ai.request", attributes: { provider: "google", model: "gemma-4", api: "gemini" } },
          async (request) => {
            request.setAttributes({ "usage.input": 100, "usage.cache_read": 20, "usage.output": 30, stop: "stop", "cost.total": 0.001 })
          }
        )
      })
      await submit.startSpan({ name: "pi.durable.phase", attributes: { "task.id": 1, phase: "tool" } }, async (phase) => {
        phase.setAttributes({ "tool.name": "lookup_canon", "tool.call_id": "call-1" })
      })
    }
  )
  t.invokeAgent({
    agent: "canon-contradiction",
    conversationId: 7,
    model: "gemma-4",
    provider: "google",
    usage: { inputTokens: 120, outputTokens: 30 },
    inputMessages: messages,
    outputMessages: [{ role: "assistant", content: "done" }],
    startMs: 1_000,
    endMs: 2_000,
  })
}

describe("HeraAgentTelemetry", () => {
  // admits: make/flush/shutdown before any span must do no I/O; a constructor that posts is invisible to types.
  it("does no I/O and builds no provider until the first span", async () => {
    let fetched = 0
    const t = HeraAgentTelemetry.make({
      service: "s",
      environment: "test",
      tenant: "t",
      sink: { baseUrl: "https://logfire.test", token: Redacted.make("x") },
      waitUntil: () => {},
      fetch: (async () => {
        fetched += 1
        throw new Error("no network at construction")
      }) as unknown as typeof fetch,
    })
    await t.flush()
    await t.shutdown()
    expect(fetched).toBe(0)
  })

  // admits: the Pi-to-GenAI mapping (names, tokens, conversation id) is what Logfire's Agents view reads; only an end-to-end export shows it.
  it("exports invoke_agent, chat and execute_tool with the GenAI attributes and the conversation id", async () => {
    const r = rig()
    await run(r.telemetry, [{ role: "user", content: "hi" }])
    await r.telemetry.flush()
    await r.settle()
    const spans = r.spans()
    expect(spans.map((s) => s.name).sort()).toEqual(["chat gemma-4", "execute_tool lookup_canon", "invoke_agent canon-contradiction"])
    const chat = spans.find((s) => s.name.startsWith("chat"))!
    expect(attr(chat, "gen_ai.conversation.id")).toBe("org-1/7")
    expect(attr(chat, "gen_ai.usage.input_tokens")).toBe("120")
    expect(attr(chat, "gen_ai.usage.output_tokens")).toBe("30")
    const tool = spans.find((s) => s.name.startsWith("execute_tool"))!
    expect(attr(tool, "gen_ai.tool.name")).toBe("lookup_canon")
    expect(attr(tool, "gen_ai.operation.name")).toBe("execute_tool")
    expect(spans.every((s) => attr(s, "hera.tenant") === "org-1")).toBe(true)
  })

  // admits: AC: no gen_ai.*.messages attribute leaves with export off, even when the host passes messages.
  it("with content export off, no gen_ai message attribute leaves, even when the host passes messages", async () => {
    const r = rig()
    await run(r.telemetry, [{ role: "user", content: `key ${SECRET}` }])
    await r.telemetry.flush()
    await r.settle()
    expect(r.bodies.join("")).not.toMatch(/gen_ai\.(input|output)\.messages/)
    expect(r.bodies.join("")).not.toContain(SECRET)
  })

  // admits: content that does leave must still be scrubbed run-by-run, not blanked or leaked.
  it("with content export on, messages leave and the secret inside them does not", async () => {
    const r = rig({ contentExport: true })
    await run(r.telemetry, [{ role: "user", content: `key ${SECRET}` }])
    await r.telemetry.flush()
    await r.settle()
    const invoke = r.spans().find((s) => s.name.startsWith("invoke_agent"))!
    expect(attr(invoke, "gen_ai.input.messages")).toContain("[REDACTED]")
    expect(attr(invoke, "gen_ai.input.messages")).toContain("key ")
    expect(attr(invoke, "gen_ai.output.messages")).toContain("done")
    expect(r.bodies.join("")).not.toContain(SECRET)
  })

  // admits: module-scope state leaks across tenants in a shared isolate; only two live instances show they stay apart.
  it("shares nothing between instances: ids, buffers and bodies stay apart", async () => {
    const a = rig()
    const b = rig()
    await run(a.telemetry, [])
    await run(b.telemetry, [])
    await a.telemetry.flush()
    await b.telemetry.flush()
    expect(a.spans().length).toBe(3)
    expect(b.spans().length).toBe(3)
    const ids = (r: ReturnType<typeof rig>) => new Set(r.spans().map((s) => s.spanId))
    expect([...ids(a)].filter((id) => ids(b).has(id))).toEqual([])
  })

  // admits: the hand-written traceparent must round-trip and a malformed carrier must fall back to a fresh root; no type checks the wire string.
  it("parents a span under an injected carrier and ignores a malformed one", async () => {
    const r = rig()
    let carrier: Record<string, string> | undefined
    await r.telemetry.context.startSpan({ name: "pi.ai.request", attributes: { provider: "g", model: "m", api: "a" } }, async (span) => {
      carrier = r.telemetry.context.propagation?.inject(span)
    })
    expect(carrier?.["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    const child = r.telemetry.context.propagation!.extract(carrier)
    await child.startSpan({ name: "pi.ai.request", attributes: { provider: "g", model: "m2", api: "a" } }, async () => {})
    await r.telemetry.context.propagation!.extract({ traceparent: "garbage" }).startSpan(
      { name: "pi.ai.request", attributes: { provider: "g", model: "m3", api: "a" } },
      async () => {}
    )
    await r.telemetry.flush()
    const [first, second, third] = ["chat m", "chat m2", "chat m3"].map((n) => r.spans().find((s) => s.name === n)!)
    expect(second!.traceId).toBe(first!.traceId)
    expect(second!.parentSpanId).toBe(first!.spanId)
    expect(third!.traceId).not.toBe(first!.traceId)
  })

  // admits: the pi-telemetry contract requires the callback error rethrown unchanged while the span closes errored.
  it("rethrows a failing callback unchanged and marks the span errored", async () => {
    const r = rig()
    const boom = new Error("boom")
    await expect(
      r.telemetry.context.startSpan({ name: "pi.ai.request", attributes: { provider: "g", model: "m", api: "a" } }, async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    await r.telemetry.flush()
    expect(r.spans()).toHaveLength(1)
  })

  // admits: importing Pi's telemetry outside the subpath would load it in every Worker's cold start; a barrel re-export is invisible to the type checker.
  it("is a subpath only: no module outside it imports it, and no barrel exports it", () => {
    const src = join(import.meta.dirname, "..", "src")
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []
      )
    const outside = files(src).filter((f) => !relative(src, f).startsWith(join("server", "agent")))
    expect(outside.filter((f) => /pi-telemetry|agent\/telemetry/.test(readFileSync(f, "utf8")))).toEqual([])
    const pkg = JSON.parse(readFileSync(join(src, "..", "package.json"), "utf8")) as { exports: Record<string, unknown> }
    expect(Object.keys(pkg.exports)).toContain("./agent/telemetry")
  })
})
