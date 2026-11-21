import { describe, expect, it } from "vitest"
import { GITLEAKS_RULES } from "../src/core/logger/index.js"
import { GITLEAKS_FIXTURES } from "./fixtures/gitleaks-secrets.js"
import { attr, rig } from "./agent-telemetry-helpers.js"

/** Puts `secret` in every place a span carries text, then exports through the real pipeline. */
async function exportWithSecret(secret: string): Promise<string> {
  const r = rig({ contentExport: true })
  const { context } = r.telemetry
  await context.startSpan({ name: "pi.ai.request", attributes: { provider: "google", model: `m-${secret}`, api: "a" } }, async (a) => {
    a.addEvent("note", { detail: `see ${secret}` })
    await context.startSpan({ name: "pi.ai.request", attributes: { provider: "google", model: "other", api: "a" } }, async (b) => {
      b.addLink({ context: a, attributes: { why: secret } })
      b.setStatus({ status: "error", error: { name: "UpstreamError", message: `rejected ${secret}` } })
    })
  })
  r.telemetry.invokeAgent({
    agent: "a",
    conversationId: 1,
    attributes: { note: secret, "x.authorization": "plain-looking-value" },
    inputMessages: [{ content: secret }],
    outputMessages: [secret],
    error: { name: "E", message: secret },
    startMs: 1,
    endMs: 2,
  })
  await r.telemetry.flush()
  await r.settle()
  expect(r.spans().length).toBeGreaterThan(0)
  return r.bodies.join("\n")
}

describe("export scrubbing", () => {
  // admits: a secret must leave in zero OTLP bodies from every text slot (name, attribute, event, link, status); the serializer output is the only place all slots meet.
  it.each(GITLEAKS_RULES.map((rule) => [rule.id] as const))(
    "a %s planted in a name, attribute, event, link, status and message leaves in zero bodies",
    async (id) => {
      const secret = GITLEAKS_FIXTURES[id]!
      const bodies = await exportWithSecret(secret)
      // A private key spans lines, so it is checked by its distinctive body, not the whole string.
      const needle = id === "private-key" ? "MIIEowIBAAKCAQEA" : secret.slice(4, 24)
      expect(bodies).not.toContain(needle)
      expect(bodies).toContain("[REDACTED]")
    }
  )

  // admits: AC: the ghp_ fixture appears in zero exported bodies; counts occurrences across the whole body.
  it("keeps the fixture ghp_ token out of every exported body", async () => {
    const secret = GITLEAKS_FIXTURES["github-pat"]!
    expect((await exportWithSecret(secret)).split(secret).length - 1).toBe(0)
  })

  // admits: SECRET_KEY_PATTERN matches input_tokens, so key redaction must skip numbers; a lint cannot see the attribute value type.
  it("redacts a string under a credential-shaped key, but keeps token counts", async () => {
    const r = rig()
    r.telemetry.invokeAgent({
      agent: "a",
      conversationId: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
      attributes: { "x.authorization": "plain-looking-value" },
      startMs: 1,
      endMs: 2,
    })
    await r.telemetry.flush()
    const span = r.spans()[0]!
    expect(attr(span, "x.authorization")).toBe("[REDACTED]")
    expect(attr(span, "gen_ai.usage.input_tokens")).toBe("10")
    expect(attr(span, "gen_ai.usage.output_tokens")).toBe("5")
  })

  // admits: content arriving as span events, not attributes, must also be dropped when export is off.
  it("drops content events as well as content attributes when export is off", async () => {
    const r = rig()
    await r.telemetry.context.startSpan({ name: "pi.ai.request", attributes: { provider: "g", model: "m", api: "a" } }, async (s) => {
      s.addEvent("gen_ai.user.message", { content: "private" })
      s.addEvent("kept.event", { ok: "yes" })
    })
    await r.telemetry.flush()
    const events = r.spans()[0]!.events?.map((e) => e.name)
    expect(events).toEqual(["kept.event"])
    expect(r.bodies.join("")).not.toContain("private")
  })

  // admits: the content gate must hold whoever set the attribute; host-side skipping alone would hide a missing gate.
  it("gates content attributes in the processor, whatever put them on the span", async () => {
    const content = {
      "gen_ai.input.messages": "in",
      "gen_ai.output.messages": "out",
      "gen_ai.system_instructions": "sys",
      "gen_ai.tool.call.arguments": "args",
      "gen_ai.tool.call.result": "res",
      "gen_ai.tool.definitions": "defs",
      "gen_ai.prompt.0.content": "legacy",
      "gen_ai.request.model": "kept-model",
    }
    for (const contentExport of [false, true]) {
      const r = rig({ contentExport })
      r.telemetry.invokeAgent({ agent: "a", conversationId: 1, attributes: content, startMs: 1, endMs: 2 })
      await r.telemetry.flush()
      const keys = (r.spans()[0]!.attributes ?? []).map((a) => a.key)
      expect(keys.includes("gen_ai.request.model")).toBe(true)
      for (const key of Object.keys(content).filter((k) => k !== "gen_ai.request.model")) {
        expect(keys.includes(key), `${key} with contentExport=${contentExport}`).toBe(contentExport)
      }
    }
  })

  // admits: key redaction covered strings only, so a credential-named array of plain values left verbatim; a value's type is runtime data.
  it("redacts a string array under a credential-named key", async () => {
    const r = rig()
    r.telemetry.invokeAgent({ agent: "a", conversationId: 1, attributes: { password: ["hunter2plain"] }, startMs: 1, endMs: 2 })
    await r.telemetry.flush()
    expect(attr(r.spans()[0]!, "password")).toBe("[REDACTED]")
    expect(r.bodies.join("")).not.toContain("hunter2plain")
  })
})
