import { describe, expect, it } from "vitest"
import { GITLEAKS_FIXTURES } from "./fixtures/gitleaks-secrets.js"
import { attr, rig } from "./agent-telemetry-helpers.js"

const SECRET = GITLEAKS_FIXTURES["github-pat"]!
const chat = (model: string) => ({ name: "pi.ai.request", attributes: { provider: "g", model, api: "a" } })

interface Resource {
  readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: { readonly stringValue?: string } }>
}

function resourceOf(body: string): Record<string, string | undefined> {
  const resource = (JSON.parse(body) as { resourceSpans: Array<{ resource: Resource }> }).resourceSpans[0]!.resource
  return Object.fromEntries(resource.attributes.map((a) => [a.key, a.value.stringValue]))
}

describe("agent export on HeraTelemetry", () => {
  // admits: Logfire showed deployment_environment = null for a deployed agent worker; the resource is wire data.
  it("stamps service, environment and version on the resource", async () => {
    const r = rig({ environment: "prod", version: "v-123" })
    await r.telemetry.context.startSpan(chat("m"), async () => {})
    await r.telemetry.flush()
    expect(resourceOf(r.bodies[0]!)).toMatchObject({
      "service.name": "test-agents",
      "deployment.environment.name": "prod",
      "service.version": "v-123",
      "telemetry.sdk.name": "@sibylline-labs/hera",
    })
  })

  // admits: pi-ai emits one pi.ai.block per content block (1,075 events over 470 spans in Logfire); event names are Pi runtime strings.
  it("drops pi.ai.block events and records the first chunk as first_chunk_latency_ms", async () => {
    const r = rig()
    await r.telemetry.context.startSpan(chat("m"), async (span) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      span.addEvent("pi.ai.first_chunk")
      span.addEvent("pi.ai.block", { type: "text", index: 0, chars: 12 })
      span.addEvent("pi.ai.block", { type: "tool_call", index: 1, chars: 40, tool: "lookup" })
      span.addEvent("pi.ai.first_chunk")
      span.addEvent("kept.event", { ok: "yes" })
    })
    await r.telemetry.flush()
    const [span] = r.spans()
    expect(span!.events?.map((e) => e.name)).toEqual(["kept.event"])
    expect(r.bodies.join("")).not.toContain("pi.ai.block")
    expect(Number(attr(span!, "first_chunk_latency_ms"))).toBeGreaterThanOrEqual(1)
    expect(span!.attributes?.filter((a) => a.key === "first_chunk_latency_ms")).toHaveLength(1)
  })

  // admits: Logfire Error Tracking groups only on logfire.exception.fingerprint with an exception event (Gate-0); the message must not leave.
  it("exports a failed chat with an exception event and a fingerprint, its message redacted", async () => {
    const r = rig()
    await expect(
      r.telemetry.context.startSpan(chat("m"), async () => {
        throw new TypeError(`upstream said ${SECRET}`)
      })
    ).rejects.toThrow(TypeError)
    await r.telemetry.flush()
    const [span] = r.spans() as Array<ReturnType<typeof r.spans>[number] & { status?: { code?: number } }>
    expect(span!.status?.code).toBe(2)
    expect(attr(span!, "logfire.exception.fingerprint")).toMatch(/^[0-9a-f]{16}$/)
    const exception = span!.events?.find((e) => e.name === "exception")
    const field = (key: string) => exception?.attributes?.find((a) => a.key === key)?.value.stringValue
    expect(field("exception.type")).toBe("TypeError")
    expect(field("exception.message")).toBe("[REDACTED]")
    expect(field("exception.stacktrace")).toMatch(/^TypeError: \[REDACTED\]\n\s+at /)
    expect(r.bodies.join("")).not.toContain(SECRET)
    expect(r.bodies.join("")).not.toContain("upstream said")
  })

  // admits: the same fault with different text must group as one issue; the fingerprint is computed at runtime.
  it("fingerprints a Pi error status and an errored invoke_agent by type, not message", async () => {
    const r = rig()
    for (const message of ["first text", "second text"]) {
      await r.telemetry.context.startSpan(chat(message.split(" ")[0]!), async (span) => {
        span.setStatus({ status: "error", error: { name: "ProviderError", message } })
      })
    }
    r.telemetry.invokeAgent({ agent: "a", conversationId: 1, error: { name: "AgentError", message: SECRET }, startMs: 1, endMs: 2 })
    await r.settle()
    await r.telemetry.flush()
    const fingerprint = (name: string) => attr(r.spans().find((s) => s.name === name)!, "logfire.exception.fingerprint")
    expect(fingerprint("chat first")).toBe(fingerprint("chat second"))
    expect(fingerprint("invoke_agent a")).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprint("invoke_agent a")).not.toBe(fingerprint("chat first"))
    expect(r.bodies.join("")).not.toContain(SECRET)
  })

  // admits: an error *name* is caller text too; an identifier-shaped token (ghp_…) passed the name check and left as exception.type.
  it.each([
    ["invokeAgent error", (t: ReturnType<typeof rig>["telemetry"]) => t.invokeAgent({ agent: "a", conversationId: 1, error: { name: SECRET, message: "x" }, startMs: 1, endMs: 2 })],
    ["Pi error status", (t: ReturnType<typeof rig>["telemetry"]) => t.context.startSpan(chat("m"), async (span) => span.setStatus({ status: "error", error: { name: SECRET, message: "x" } }))],
    ["thrown error", (t: ReturnType<typeof rig>["telemetry"]) => t.context.startSpan(chat("m"), async () => {
      const error = new Error("x")
      error.name = `Weird${SECRET}`
      throw error
    }).catch(() => undefined)],
  ] as const)("keeps a secret-shaped error name out of exception.type, the stack and status (%s)", async (_label, act) => {
    const r = rig()
    await act(r.telemetry)
    await r.settle()
    await r.telemetry.flush()
    expect(r.spans()).toHaveLength(1)
    expect(r.bodies.join("")).not.toContain(SECRET.slice(4, 24))
  })

  // admits: a blank service name made core's resolver throw inside Pi's startSpan; telemetry must never throw into the agent.
  it("reports unconfigured, and never throws into the agent, for a blank service name", async () => {
    const r = rig({ service: "  " })
    await expect(r.telemetry.context.startSpan(chat("m"), async () => "ok")).resolves.toBe("ok")
    await r.telemetry.flush()
    expect(r.bodies).toEqual([])
    expect(r.reports.map((x) => x.outcome)).toEqual(["unconfigured"])
  })

  // admits: spans refused before the GenAI filter were never counted, so an operator saw 1 dropped of 5.
  it("counts every span the buffer refused as dropped", async () => {
    const r = rig({ maxBufferedSpans: 1 })
    for (let i = 0; i < 6; i++) await r.telemetry.context.startSpan(chat(`m${i}`), async () => {})
    await r.telemetry.flush()
    expect(r.reports).toEqual([{ outcome: "sent", spans: 1, dropped: 5 }])
  })

  // admits: an async reporter's rejection escaped as an unhandled rejection, which can crash a Node test runner or a workerd isolate log.
  it("contains a rejecting async onExport", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      const r = rig({ onExport: async () => Promise.reject(new Error("async boom")) })
      await r.telemetry.context.startSpan(chat("m"), async () => {})
      await expect(r.telemetry.flush()).resolves.toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  // admits: a flush whose GenAI spans were all refused posted nothing yet reported "sent"; the outcome literal is runtime data.
  it("reports overflowed, not sent, when every GenAI span of a flush was refused", async () => {
    const r = rig({ maxBufferedSpans: 1 })
    await r.telemetry.context.startSpan({ name: "pi.durable.phase", attributes: { phase: "a" } }, async () => {})
    await r.telemetry.context.startSpan({ name: "pi.durable.phase", attributes: { phase: "b" } }, async () => {})
    for (let i = 0; i < 3; i++) await r.telemetry.context.startSpan(chat(`m${i}`), async () => {})
    await r.telemetry.flush()
    expect(r.bodies).toEqual([])
    expect(r.reports).toEqual([{ outcome: "overflowed", spans: 0, dropped: 3 }])
  })
})
