import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { HeraError } from "../src/core/errors/index.js"
import { HeraAgentEgress } from "../src/server/agent/egress/egress.js"
import { HeraAgentMeter } from "../src/server/agent/egress/meter.js"
import { HeraAgentModels } from "../src/server/agent/models/catalog.js"
import { agentTool } from "../src/server/agent/tool/agent-tool.js"
import { toolParameters, toRegistration } from "../src/server/agent/tool/registration.js"
import { HeraAgentTest, type HeraAgentScriptStep } from "../src/testing/agent/index.js"

const ctx = BACKGROUND_CONTEXT
const Lookup = Schema.Struct({ key: Schema.String })

function lookupTool(calls: Array<{ callId: string; key: string }>) {
  return agentTool({
    name: "lookup",
    description: "Look up a value.",
    input: Lookup,
    execute: ({ key }, { callId }) =>
      Effect.sync(() => {
        calls.push({ callId, key })
        return `${key}=v`
      }),
  })
}

/** One Pi run over a scripted model through Hera's egress; answers the tool results Pi recorded. */
async function run(steps: ReadonlyArray<HeraAgentScriptStep>, tool: ReturnType<typeof lookupTool>) {
  const models = HeraAgentEgress.make({
    config: { accountId: "acct", gateway: "gw", apiKey: "k" },
    metadata: { tenant: "org_t", agent: "probe", service: "test" },
    model: HeraAgentModels.default,
    meter: HeraAgentMeter.memory(),
    upstream: HeraAgentTest.script(steps),
  })
  const registry = createRegistry()
  registry.install({ name: "probe", sections: [], tools: [toRegistration(tool)] })
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx)
  const root = await harness.root(ctx, { agent: { model: { provider: "google", modelId: "gemma-4-26b-a4b-it" } } })
  const settled = await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx)
  const page = await root.entries({ order: "ascending" }, 100, undefined, ctx)
  const results = page.items
    .flatMap((e) => e.model ?? [])
    .filter((m) => m.role === "toolResult")
    .map((m) => ({ id: m.toolCallId, isError: m.isError, text: m.content.map((c) => (c.type === "text" ? c.text : "")).join("") }))
  await harness.close(ctx)
  return { status: settled.status, results }
}

describe("Hera.agentTool", () => {
  // admits: Pi coerces {key:3} to {key:"3"} before execute; only a decode of the raw args can refuse it.
  it("rejects a Pi-coerced input ({key:3} against a string schema) without running the handler", async () => {
    const calls: Array<{ callId: string; key: string }> = []
    const { status, results } = await run(
      [HeraAgentTest.toolCall("lookup", { key: 3 }), HeraAgentTest.toolCall("lookup", { key: "alpha" }), HeraAgentTest.text("done")],
      lookupTool(calls)
    )
    expect(status).toBe("done")
    expect(calls).toEqual([{ callId: "call_1_0", key: "alpha" }])
    expect(results[0]).toMatchObject({ id: "call_0_0", isError: true })
    expect(results[0]?.text).toContain("agent_tool_input_invalid")
    expect(results[1]).toEqual({ id: "call_1_0", isError: false, text: "alpha=v" })
  })

  // admits: the Pi default (replay "unsafe") silently leaking in, or the callId not reaching the handler.
  it("defaults to replay safe, offers the Effect JSON Schema, and passes the callId", () => {
    const tool = lookupTool([])
    expect(tool.replay).toBe("safe")
    const registration = toRegistration(tool)
    expect(registration.replay).toBe("safe")
    expect(registration.parameters).toEqual(Schema.toJsonSchemaDocument(Lookup).schema)
    expect(toolParameters(tool)).toMatchObject({ type: "object", required: ["key"] })
  })

  // admits: a handler's typed failure text leaking to the model or logs.
  it("maps a typed handler failure to an error result naming only its tag and code", async () => {
    const LookupMissing = HeraError.define("LookupMissing", { code: "not_found", fields: { secret: Schema.String } })
    const failing = agentTool({
      name: "lookup",
      description: "d",
      input: Lookup,
      execute: () => Effect.fail(new LookupMissing({ secret: "do-not-leak" })),
    })
    const { results } = await run([HeraAgentTest.toolCall("lookup", { key: "a" }), HeraAgentTest.text("done")], failing as ReturnType<typeof lookupTool>)
    expect(results[0]).toEqual({ id: "call_0_0", isError: true, text: "tool failed: LookupMissing (not_found)" })
  })

  // admits: a name Gemini function declarations refuse surfacing at the first model request, mid-run, instead of at module init.
  it("refuses an invalid tool name at declaration", () => {
    expect(() => agentTool({ name: "bad name", description: "d", input: Lookup, execute: () => Effect.succeed("") })).toThrow(/valid tool name/)
  })
})
