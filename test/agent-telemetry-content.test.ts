import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import type { TelemetrySpan } from "@earendil-works/pi-telemetry"
import { describe, expect, it } from "vitest"
import { recordChatContent, recordToolContent } from "../src/server/agent/telemetry/content-recorder.js"
import { capJson, capText, inputMessagesOf, MAX_PART_CHARS, systemInstructionsOf } from "../src/server/agent/telemetry/genai-content.js"
import { GITLEAKS_FIXTURES } from "./fixtures/gitleaks-secrets.js"
import { attr, rig, type OtlpSpan } from "./agent-telemetry-helpers.js"

const SECRET = GITLEAKS_FIXTURES["github-pat"]!
const CONTENT_KEYS = [
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
]

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const messages: Message[] = [
  { role: "system", content: "You resolve Canon entries.", sections: { tools: "<tools>apply</tools>" }, timestamp: 0 },
  { role: "user", content: `resolve this; token ${SECRET}`, timestamp: 0 },
  { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "lookup", arguments: { key: "alpha" } }], api: "a", provider: "google", model: "m", usage, stopReason: "toolUse", timestamp: 0 },
  { role: "toolResult", toolCallId: "c1", toolName: "lookup", content: [{ type: "text", text: "alpha=v" }], isError: false, timestamp: 0 },
]
const reply: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "the value is alpha=v" },
    { type: "text", text: "alpha=v" },
  ],
  api: "a",
  provider: "google",
  model: "m",
  usage,
  stopReason: "stop",
  timestamp: 0,
}

/** One model turn and one tool call through the Pi adapter, content recorded at both seams. */
async function run(contentExport: boolean): Promise<OtlpSpan[]> {
  const r = rig({ contentExport })
  const { context } = r.telemetry
  await context.startSpan({ name: "pi.durable.phase", attributes: { phase: "model", "conversation.id": 1 } }, async (phase) => {
    await phase.startSpan({ name: "pi.ai.request", attributes: { provider: "google", model: "m", api: "a" } }, async () => {
      recordChatContent(phase, messages, reply)
    })
  })
  await context.startSpan({ name: "pi.durable.phase", attributes: { phase: "tool" } }, async (phase) => {
    phase.setAttributes({ "tool.name": "lookup", "tool.call_id": "c1" })
    recordToolContent(phase, { key: "alpha" }, { output: [{ type: "text", text: `alpha=v ${SECRET}` }] })
  })
  await r.telemetry.flush()
  await r.settle()
  return r.spans()
}

const keysOf = (span: OtlpSpan | undefined) => (span?.attributes ?? []).map((a) => a.key)

describe("GenAI content on chat and execute_tool spans", () => {
  // admits: content leaking for a metadata-only org, or missing for an opted-in one; the gate is a runtime switch per telemetry instance.
  it("records all five content keys only with contentExport, scrubbed of credentials", async () => {
    const on = await run(true)
    const chat = on.find((s) => s.name === "chat m")
    const tool = on.find((s) => s.name === "execute_tool lookup")
    expect(JSON.parse(attr(chat!, "gen_ai.system_instructions")!)).toEqual([
      { type: "text", content: "You resolve Canon entries." },
      { type: "text", content: "<tools>apply</tools>" },
    ])
    const input = JSON.parse(attr(chat!, "gen_ai.input.messages")!) as Array<{ role: string; parts: Array<Record<string, unknown>> }>
    expect(input.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
    expect(input[1]!.parts[0]).toEqual({ type: "tool_call", id: "c1", name: "lookup", arguments: { key: "alpha" } })
    expect(input[2]!.parts[0]).toEqual({ type: "tool_call_response", id: "c1", response: "alpha=v" })
    expect(JSON.parse(attr(chat!, "gen_ai.output.messages")!)).toEqual([
      { role: "assistant", parts: [{ type: "reasoning", content: "the value is alpha=v" }, { type: "text", content: "alpha=v" }], finish_reason: "stop" },
    ])
    expect(attr(tool!, "gen_ai.tool.call.arguments")).toBe('{"key":"alpha"}')
    expect(attr(tool!, "gen_ai.tool.call.result")).toContain("alpha=v")
    const body = JSON.stringify(on)
    expect(body).not.toContain(SECRET)
    expect(body).toContain("[REDACTED]")

    const off = await run(false)
    expect(off.map((s) => s.name).sort()).toEqual(["chat m", "execute_tool lookup"])
    for (const span of off) for (const key of CONTENT_KEYS) expect(keysOf(span)).not.toContain(key)
  })

  // admits: a telemetry failure (unserialisable args, a foreign span) breaking the agent's tool call or model turn.
  it("never throws: unserialisable arguments, a foreign span and no span all record nothing", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic
    const foreign = { startSpan: () => Promise.resolve() } as unknown as TelemetrySpan
    expect(() => recordToolContent(undefined, cyclic, { output: [] })).not.toThrow()
    expect(() => recordToolContent(foreign, cyclic, { output: [] })).not.toThrow()
    expect(() => recordChatContent(foreign, messages, reply)).not.toThrow()
  })

  // admits: a long prompt producing a truncated, unparseable JSON attribute instead of a capped part.
  it("caps each part's text and keeps the value valid JSON", () => {
    const long = "x".repeat(MAX_PART_CHARS + 10)
    expect(capText(long)).toBe(`${"x".repeat(MAX_PART_CHARS)}…[truncated 10 chars]`)
    const parsed = JSON.parse(JSON.stringify(inputMessagesOf([{ role: "user", content: long, timestamp: 0 }])))
    expect(parsed[0].parts[0].content).toHaveLength(MAX_PART_CHARS + "…[truncated 10 chars]".length)
    expect(systemInstructionsOf([{ role: "user", content: "hi", timestamp: 0 }])).toBeUndefined()
  })

  // admits: the cap cutting a credential into a prefix no Gitleaks shape matches, which the export scrubber then lets through.
  it("scrubs before it caps: a credential straddling the cap never leaves in part", () => {
    const padded = `${"x".repeat(MAX_PART_CHARS - 20)}${SECRET}`
    const capped = capText(padded)
    expect(capped).not.toContain(SECRET.slice(0, 19))
    expect(capped.startsWith("x".repeat(MAX_PART_CHARS - 20))).toBe(true)
  })

  // admits: large tool arguments (a file write) exported as an unparseable `gen_ai.tool.call.arguments` string.
  it("caps strings inside tool arguments and keeps them valid JSON", async () => {
    const big = { path: "a.txt", body: "y".repeat(MAX_PART_CHARS + 61) }
    expect(JSON.parse(JSON.stringify(capJson(big)))).toEqual({ path: "a.txt", body: capText(big.body) })
    const r = rig({ contentExport: true })
    await r.telemetry.context.startSpan({ name: "pi.durable.phase", attributes: { phase: "tool" } }, async (phase) => {
      phase.setAttributes({ "tool.name": "write" })
      recordToolContent(phase, big, { output: [{ type: "text", text: "ok" }] })
    })
    await r.telemetry.flush()
    await r.settle()
    const tool = r.spans().find((s) => s.name === "execute_tool write")
    expect(JSON.parse(attr(tool!, "gen_ai.tool.call.arguments")!).body).toHaveLength(MAX_PART_CHARS + "…[truncated 61 chars]".length)
  })
})
