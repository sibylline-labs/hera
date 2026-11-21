import type { TelemetryCarrier, TelemetryContext } from "@earendil-works/pi-telemetry"
import { describe, expect, it } from "vitest"
import { type OtlpSpan, rig } from "./agent-telemetry-helpers.js"

const chat = (model: string) => ({ name: "pi.ai.request", attributes: { provider: "g", model, api: "a" } })

/** Parent ids among `spans` that no span in `spans` carries, besides `allowed`. */
function dangling(spans: ReadonlyArray<OtlpSpan>, allowed: ReadonlyArray<string> = []): ReadonlyArray<string> {
  const ids = new Set([...spans.map((s) => s.spanId), ...allowed])
  return spans.map((s) => s.parentSpanId).filter((id): id is string => id !== undefined && !ids.has(id))
}

/** Pi's submit: a non-GenAI span whose carrier the task records (`pi_tasks.record.trace`). */
async function submit(context: TelemetryContext): Promise<TelemetryCarrier> {
  let carrier: TelemetryCarrier | undefined
  await context.startSpan({ name: "pi.durable.submit", attributes: { "conversation.id": 1 } }, async (span) => {
    carrier = context.propagation!.inject(span)
  })
  return carrier!
}

describe("agent GenAI spans never point at a dropped span", () => {
  // admits: a chat flushed while its phase is open, then the phase dropped, leaving the chat orphaned; flush timing is runtime
  it("a run across flushes exports one trace with no dangling parent", async () => {
    const r = rig()
    const { context } = r.telemetry
    const task = await submit(context)
    await r.telemetry.flush()
    await context.propagation!.extract(task).startSpan({ name: "pi.durable.phase", attributes: { phase: "model" } }, async (phase) => {
      await phase.startSpan(chat("m"), async () => {})
      await r.telemetry.flush()
    })
    await context.propagation!.extract(task).startSpan({ name: "pi.durable.phase", attributes: { phase: "tool" } }, async (phase) => {
      phase.setAttributes({ "tool.name": "t1" })
    })
    await r.telemetry.flush()
    r.telemetry.invokeAgent({ agent: "a", conversationId: 1, parent: task, startMs: 1, endMs: 2 })
    await r.settle()
    await r.telemetry.flush()
    const spans = r.spans()
    expect(spans.map((s) => s.name).sort()).toEqual(["chat m", "execute_tool t1", "invoke_agent a"])
    expect(dangling(spans)).toEqual([])
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1)
    expect(spans[0]!.traceId).toBe(task["traceparent"]!.split("-")[1])
  })

  // admits: a task carrier written before an eviction naming a span the new isolate never saw; isolate lifetime is runtime
  it("a carrier from an earlier isolate parents nothing on its dropped span", async () => {
    const task = await submit(rig().telemetry.context)
    const r = rig()
    const { context } = r.telemetry
    await context.propagation!.extract(task).startSpan({ name: "pi.durable.phase", attributes: { phase: "model" } }, async (phase) => {
      await phase.startSpan(chat("m"), async () => {})
    })
    r.telemetry.invokeAgent({ agent: "a", conversationId: 1, parent: task, startMs: 1, endMs: 2 })
    await r.settle()
    const spans = r.spans()
    expect(spans).toHaveLength(2)
    expect(dangling(spans)).toEqual([])
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([task["traceparent"]!.split("-")[1]]))
  })

  // admits: a child task carried from a phase that ended dropped in an earlier isolate; phase fate is known only at its end
  it("a child task carried from a phase parents nothing on that phase in a later isolate", async () => {
    const first = rig().telemetry.context
    const task = await submit(first)
    let child: TelemetryCarrier | undefined
    await first.propagation!.extract(task).startSpan({ name: "pi.durable.phase", attributes: { phase: "plan" } }, async (phase) => {
      child = first.propagation!.inject(phase)
    })
    const r = rig()
    await r.telemetry.context.propagation!.extract(child!).startSpan({ name: "pi.durable.phase", attributes: { phase: "model" } }, async (phase) => {
      await phase.startSpan(chat("m"), async () => {})
    })
    await r.telemetry.flush()
    const spans = r.spans()
    expect(spans.map((s) => s.name)).toEqual(["chat m"])
    expect(dangling(spans)).toEqual([])
    expect(spans[0]!.traceId).toBe(task["traceparent"]!.split("-")[1])
  })

  // admits: the rule severing a caller's own exported span passed as the run's parent; carriers are runtime data
  it("a carrier Hera did not write stays the parent", async () => {
    const r = rig()
    const remote = `00-${"c".repeat(32)}-${"d".repeat(16)}-01`
    r.telemetry.invokeAgent({ agent: "a", conversationId: 1, parent: { traceparent: remote }, startMs: 1, endMs: 2 })
    await r.settle()
    const [span] = r.spans()
    expect(span!.traceId).toBe("c".repeat(32))
    expect(span!.parentSpanId).toBe("d".repeat(16))
  })
})
