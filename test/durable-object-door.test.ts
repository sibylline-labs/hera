import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { createHeraLogger } from "../src/core/logger/index.js"
import type { HeraTelemetry } from "../src/core/telemetry/types.js"
import { Hera } from "../src/index"
import { HERA_RPC_META_MARK } from "../src/server/rpc/index"
import { type HeraDoorWithin, runDoor, runDoorSync } from "../src/server/durable-object/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"
import { SAMPLE_IDS } from "../src/testing/index"
import { logsOf, makeTelemetryHarness, spansOf } from "./telemetry-helpers.js"

const TRACE = "c".repeat(32)
const PARENT = "d".repeat(16)
const meta = { [HERA_RPC_META_MARK]: true, traceparent: `00-${TRACE}-${PARENT}-01` } as const
const logger = createHeraLogger({ service: "door" })

function nested(within: HeraDoorWithin, msg: string): Promise<void> {
  // A fresh runtime, as `runWithTenantCtx` starts one: only `within` ties it to the door.
  // hera-allow: raw-effect-run
  return Effect.runPromise(within(logger.info(msg)))
}

describe("runDoor", () => {
  // admits: integration: span parenting from a trailing marked meta and the context graft across a
  // fresh Effect.runPromise are runtime properties no type or lint sees (AC1).
  it("exports its span under the caller's trace, with a line logged on a nested runtime", async () => {
    const h = makeTelemetryHarness()
    const value = await runDoor(h, "svc.read", ["input", meta], async (within) => {
      await nested(within, "door.nested")
      return { ok: 1 }
    })
    await h.settle()

    expect(value).toEqual({ ok: 1 })
    const spans = h.posts.flatMap(spansOf)
    const door = spans.find((s) => s.name === "svc.read")
    expect(door?.traceId).toBe(TRACE)
    expect(door?.parentSpanId).toBe(PARENT)
    const line = h.posts.flatMap(logsOf).find((l) => (l.body as { stringValue?: string }).stringValue === "door.nested")
    expect(line?.traceId).toBe(TRACE)
    expect(line?.spanId).toBe(door?.spanId)
  })

  // admits: integration: the caller awaits the stub and must see the body's own rejection (same
  // reference), not a FiberFailure or an envelope; and the failed door still exports.
  it("answers the body's own value and rejection", async () => {
    const h = makeTelemetryHarness()
    const value = { rows: [1, 2] }
    expect(await runDoor(h, "svc.ok", [], async () => value)).toBe(value)
    const own = new Error("refused")
    const caught = await runDoor(h, "svc.fail", [meta], async () => Promise.reject(own)).catch((e: unknown) => e)
    expect(caught).toBe(own)
    await h.settle()
    expect(h.posts.flatMap(spansOf).some((s) => s.name === "svc.fail" && s.traceId === TRACE)).toBe(true)
  })

  // admits: algorithmic: only the last argument is read as meta (a meta elsewhere is input), no meta
  // starts a fresh root, and runDoorSync answers and throws synchronously.
  it("reads only a trailing meta, and runDoorSync answers synchronously", async () => {
    const h = makeTelemetryHarness()
    await runDoor(h, "svc.root", [meta, "last"], async () => undefined)
    expect(runDoorSync(h, "svc.sync", [meta], () => 7)).toBe(7)
    const own = new Error("sync refused")
    expect(() => runDoorSync(h, "svc.sync.fail", [], () => { throw own })).toThrow(own)
    await h.settle()
    const spans = h.posts.flatMap(spansOf)
    const root = spans.find((s) => s.name === "svc.root")
    expect(root?.traceId).not.toBe(TRACE)
    expect(root?.parentSpanId ?? "").toBe("")
    expect(spans.find((s) => s.name === "svc.sync")?.traceId).toBe(TRACE)
  })
})

class DoorDO extends Hera.TenantDurableObject.configure({ service: "door-do" }) {
  static telemetry: HeraTelemetry | undefined
  protected override telemetry(): HeraTelemetry | undefined {
    return DoorDO.telemetry
  }
  read(input: string, ...callArgs: ReadonlyArray<unknown>): Promise<string> {
    return this.runDoor("door-do.read", callArgs, async (within) => {
      await this.runWithTenantCtx(within(logger.info("door-do.read")))
      return `${input}:${this.orgId}`
    })
  }
  count(...callArgs: ReadonlyArray<unknown>): number {
    return this.runDoorSync("door-do.count", callArgs, () => 3)
  }
}

describe("HeraDurableObjectBase.runDoor", () => {
  // admits: integration: the base wiring (telemetry() and ctx.waitUntil) across a real
  // TenantDurableObject and its runWithTenantCtx runtime.
  it("runs under telemetry() and ctx.waitUntil, and still answers without telemetry", async () => {
    const h = makeTelemetryHarness()
    const harness = makeTestDurableObjectState({ idName: SAMPLE_IDS.orgId })
    ;(harness.state as { waitUntil: (p: Promise<unknown>) => void }).waitUntil = h.waitUntil
    const object = new DoorDO(harness.state, {})

    DoorDO.telemetry = h.telemetry
    expect(await object.read("x", meta)).toBe(`x:${SAMPLE_IDS.orgId}`)
    expect(object.count(meta)).toBe(3)
    await h.settle()
    const spans = h.posts.flatMap(spansOf)
    expect(spans.find((s) => s.name === "door-do.read")?.traceId).toBe(TRACE)
    expect(spans.find((s) => s.name === "door-do.count")?.traceId).toBe(TRACE)
    expect(h.posts.flatMap(logsOf).some((l) => (l.body as { stringValue?: string }).stringValue === "door-do.read")).toBe(true)

    DoorDO.telemetry = undefined
    expect(await object.read("y")).toBe(`y:${SAMPLE_IDS.orgId}`)
  })
})
