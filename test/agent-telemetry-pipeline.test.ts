import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import { HeraAgentTelemetry } from "../src/server/agent/telemetry/index.js"
import { rig } from "./agent-telemetry-helpers.js"

const chat = (model: string) => ({ name: "pi.ai.request", attributes: { provider: "g", model, api: "a" } })

describe("GenAI filter and flushing", () => {
  // admits: AC: only invoke_agent, chat and execute_tool spans leave a mixed trace; span names are runtime data.
  it("exports only GenAI spans out of a mixed trace", async () => {
    const r = rig()
    const { context } = r.telemetry
    await context.startSpan({ name: "pi.durable.submit", attributes: { "submission.type": "write", "conversation.id": 1 } }, async (submit) => {
      await submit.startSpan({ name: "GET /agent", attributes: {} }, async () => {})
      await submit.startSpan({ name: "alarm", attributes: {} }, async () => {})
      await submit.startSpan({ name: "pi.durable.phase", attributes: { phase: "x" } }, async (phase) => {
        await phase.startSpan(chat("m"), async () => {})
      })
      await submit.startSpan({ name: "pi.durable.phase", attributes: { phase: "t" } }, async (phase) => {
        phase.setAttributes({ "tool.name": "t1" })
      })
    })
    await r.telemetry.flush()
    expect(r.spans().map((s) => s.name).sort()).toEqual(["chat m", "execute_tool t1"])
  })

  // admits: dropping a middle span must not orphan its children in Logfire's trace tree.
  it("re-parents a chat under a dropped phase to the nearest kept ancestor, in one trace", async () => {
    const r = rig()
    const { context } = r.telemetry
    let carrier: Record<string, string> | undefined
    // A kept root, then a dropped phase extracted from its carrier, then a kept leaf.
    await context.startSpan({ name: "pi.ai.request", attributes: { provider: "g", model: "root", api: "a" } }, async (root) => {
      carrier = context.propagation?.inject(root)
      await context.propagation!.extract(carrier).startSpan({ name: "pi.durable.phase", attributes: { phase: "p" } }, async (phase) => {
        await phase.startSpan(chat("leaf"), async () => {})
      })
    })
    await r.telemetry.flush()
    const spans = r.spans()
    const root = spans.find((s) => s.name === "chat root")!
    const leaf = spans.find((s) => s.name === "chat leaf")!
    expect(spans).toHaveLength(2)
    expect(leaf.parentSpanId).toBe(root.spanId)
    expect(leaf.traceId).toBe(root.traceId)
  })

  // admits: the Logfire volume cap rests on 17 spans per 8-turn run in one POST.
  it("exports at most 17 spans for an 8-turn run, in one POST", async () => {
    const r = rig()
    const { context } = r.telemetry
    for (let turn = 0; turn < 8; turn++) {
      await context.startSpan({ name: "pi.durable.phase", attributes: { phase: "model" } }, async (phase) => {
        await phase.startSpan(chat(`m${turn}`), async () => {})
      })
      await context.startSpan({ name: "pi.durable.phase", attributes: { phase: "tool" } }, async (phase) => {
        phase.setAttributes({ "tool.name": `t${turn}` })
      })
    }
    r.telemetry.invokeAgent({ agent: "a", conversationId: 1, startMs: 1, endMs: 2 })
    await r.settle()
    await r.telemetry.flush()
    expect(r.spans()).toHaveLength(17)
    expect(r.bodies).toHaveLength(1)
  })

  // admits: a run's end must export through waitUntil without an explicit host flush, or spans are lost on eviction.
  it("flushes on the invoke_agent ending, through waitUntil, without an explicit flush", async () => {
    const r = rig()
    await r.telemetry.context.startSpan(chat("m"), async () => {})
    r.telemetry.invokeAgent({ agent: "a", conversationId: 1, startMs: 1, endMs: 2 })
    await r.settle()
    expect(r.spans().map((s) => s.name).sort()).toEqual(["chat m", "invoke_agent a"])
  })

  // admits: concurrent flushes (invoke_agent end racing the host) must not double-send; the buffer swap is a runtime interleaving.
  it("sends each span once when flushes run concurrently, and nothing when empty", async () => {
    const r = rig()
    await r.telemetry.flush()
    expect(r.bodies).toHaveLength(0)
    await r.telemetry.context.startSpan(chat("m"), async () => {})
    await Promise.all([r.telemetry.flush(), r.telemetry.flush(), r.telemetry.flush()])
    expect(r.spans()).toHaveLength(1)
    expect(r.bodies).toHaveLength(1)
  })

  // admits: telemetry must never throw into the agent; an unreachable or refusing sink resolves with a closed outcome.
  it("resolves, never throws, and reports a closed outcome when the sink fails or refuses", async () => {
    const down = rig({
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED secret-host")
      }) as unknown as typeof fetch,
    })
    await down.telemetry.context.startSpan(chat("m"), async () => {})
    await expect(down.telemetry.flush()).resolves.toBeUndefined()
    expect(down.reports).toEqual([{ outcome: "unreachable", spans: 1, dropped: 0 }])

    const refused = rig({ status: 500 })
    await refused.telemetry.context.startSpan(chat("m"), async () => {})
    await expect(refused.telemetry.flush()).resolves.toBeUndefined()
    expect(refused.reports.map((x) => x.outcome)).toEqual(["rejected"])
  })

  // admits: a token without its URL (or the reverse) must send nothing, never default a host.
  it("refuses to send when the URL or the token is missing, never defaulting a host", async () => {
    let fetched = 0
    const spy = (async () => {
      fetched += 1
      return new Response("{}")
    }) as unknown as typeof fetch
    for (const sink of [{ token: Redacted.make("t") }, { baseUrl: "https://logfire.test" }, {}]) {
      const reports: string[] = []
      const t = HeraAgentTelemetry.make({
        service: "s",
        environment: "test",
        tenant: "t",
        sink,
        waitUntil: () => {},
        fetch: spy,
        onExport: (x) => reports.push(x.outcome),
      })
      await t.context.startSpan(chat("m"), async () => {})
      await t.flush()
      expect(reports).toEqual(["unconfigured"])
    }
    expect(fetched).toBe(0)
  })

  // admits: the buffer cap bounds memory and volume; the overflow count is what an operator sees.
  it("keeps the first maxBufferedSpans and counts the rest as dropped", async () => {
    const r = rig({ maxBufferedSpans: 4 })
    for (let i = 0; i < 7; i++) await r.telemetry.context.startSpan(chat(`m${i}`), async () => {})
    await r.telemetry.flush()
    expect(r.spans().map((s) => s.name)).toEqual(["chat m0", "chat m1", "chat m2", "chat m3"])
    expect(r.reports).toEqual([{ outcome: "sent", spans: 4, dropped: 3 }])
  })

  // admits: the Logfire wire contract (URL, Authorization value, content type) is not held by any type.
  it("posts to ${baseUrl}/v1/traces with the token as Authorization", async () => {
    const seen: Array<{ url: string; auth: string | null; type: string | null }> = []
    const t = HeraAgentTelemetry.make({
      service: "s",
      environment: "test",
      tenant: "t",
      sink: { baseUrl: "https://logfire.test/", token: Redacted.make("write-token") },
      waitUntil: () => {},
      fetch: (async (url: string, init?: RequestInit) => {
        const h = Object.fromEntries(new Headers(init?.headers))
        seen.push({ url, auth: h["authorization"] ?? null, type: h["content-type"] ?? null })
        return new Response("{}")
      }) as unknown as typeof fetch,
    })
    await t.context.startSpan(chat("m"), async () => {})
    await t.flush()
    expect(seen).toEqual([{ url: "https://logfire.test/v1/traces", auth: "write-token", type: "application/json" }])
  })
})
