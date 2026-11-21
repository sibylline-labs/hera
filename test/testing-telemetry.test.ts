import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { HeraTelemetry } from "../src/core/telemetry/index.js"
import { HeraAgentTelemetry } from "../src/server/agent/telemetry/index.js"
import { HeraTest } from "../src/testing/index.js"
import { GITLEAKS_FIXTURES } from "./fixtures/gitleaks-secrets.js"

const SECRET = GITLEAKS_FIXTURES["github-pat"]!

describe("HeraTest.telemetry()", () => {
  // admits: a consumer test must see what really leaves (scrubbed, encoded), not a pre-scrub fake; only a real run shows it.
  it("captures scrubbed spans and log records from a real invocation, with no network mock", async () => {
    const t = HeraTest.telemetry()
    const program = Effect.logInfo(`saw ${SECRET}`).pipe(
      Effect.withSpan("work", { attributes: { note: `key ${SECRET}`, "x.token": "plain" } })
    )
    await Effect.runPromise(HeraTelemetry.run(t.telemetry, { name: "test", source: "external", waitUntil: t.waitUntil }, program))
    await t.settle()
    const [span] = t.spans()
    expect(span?.name).toBe("work")
    expect(span?.resource["deployment.environment.name"]).toBe("test")
    expect(span?.attributes["x.token"]).toBe("[REDACTED]")
    expect(String(span?.attributes["note"])).toContain("[REDACTED]")
    expect(t.logs().map((log) => log.severityText)).toEqual(["INFO"])
    expect(JSON.stringify(t.posts.map((post) => post.body))).not.toContain(SECRET)
  })

  // admits: tail-promotion is the production export rule; a capture that bypassed it would pass tests prod fails.
  it("with headRate 0, exports a defect through tail-promotion and nothing for a success", async () => {
    const t = HeraTest.telemetry({ sampling: { headRate: 0 } })
    await Effect.runPromise(HeraTelemetry.run(t.telemetry, { name: "test", source: "external", waitUntil: t.waitUntil }, Effect.void.pipe(Effect.withSpan("fine"))))
    await t.settle()
    expect(t.posts).toEqual([])
    await Effect.runPromiseExit(HeraTelemetry.run(t.telemetry, { name: "test", source: "external", waitUntil: t.waitUntil }, Effect.die(new Error("boom")).pipe(Effect.withSpan("broken"))))
    await t.settle()
    expect(t.spans().map((span) => span.name)).toEqual(["broken"])
    expect(t.spans()[0]?.attributes["logfire.exception.fingerprint"]).toMatch(/^[0-9a-f]{16}$/)
  })

  // admits: the agent plane must be capturable through the same host; a second fake would drift from the real wiring.
  it("captures HeraAgentTelemetry spans through the same sink, fetch and waitUntil", async () => {
    const t = HeraTest.telemetry()
    const agent = HeraAgentTelemetry.make({
      service: "agents",
      environment: "test",
      tenant: "org-1",
      sink: t.sink,
      fetch: t.fetch,
      waitUntil: t.waitUntil,
    })
    agent.invokeAgent({ agent: "a", conversationId: 1, attributes: { note: SECRET }, startMs: 1, endMs: 2 })
    await t.settle()
    const [span] = t.spans()
    expect(span?.name).toBe("invoke_agent a")
    expect(span?.attributes["gen_ai.conversation.id"]).toBe("org-1/1")
    expect(span?.attributes["note"]).toBe("[REDACTED]")
  })

  // admits: a deployable importing the root or core barrel must not reach a test double.
  it("is reachable only from /testing, never the root or core barrel", async () => {
    const root = await import("../src/index.js")
    const core = await import("../src/core/index.js")
    for (const barrel of [root, core] as ReadonlyArray<Record<string, unknown>>) {
      expect(barrel["makeTestTelemetry"]).toBeUndefined()
      expect(barrel["HeraTest"]).toBeUndefined()
    }
  })
})
