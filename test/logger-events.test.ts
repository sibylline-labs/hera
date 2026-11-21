import * as Effect from "effect/Effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createHeraLogger,
  type HeraEventLogger,
  type HeraEventLoggerSync,
  type LogLevel,
} from "../src/index"

const EVENTS = ["probe.started", "probe.failed"] as const
type ProbeEvent = (typeof EVENTS)[number]
const ORG = "org_01HZX3Q4W5E6R7T8Y9A0B1C2D3"
const OTHER_ORG = "org_01HZX3Q4W5E6R7T8Y9A0B1C2D4"

function capture() {
  const lines: Array<Record<string, unknown>> = []
  const logger = createHeraLogger({
    service: "graph",
    events: EVENTS,
    fields: { product: "graph" },
    sink: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>)
    },
  })
  return { logger, lines }
}

/** The fields a line carries beyond Hera's fixed head, for `toEqual` against what the caller wrote. */
function own(line: Record<string, unknown> | undefined): Record<string, unknown> {
  const { timestamp: _t, service: _s, request_id: _r, actor_id: _a, span: _p, ...rest } = line ?? {}
  return rest
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("createHeraLogger({ events })", () => {
  // admits: a level writes the wrong `level`, `msg` or `event`, on either surface; runtime output
  it.each(["debug", "info", "warn", "error"] as const)(
    "%s writes one line naming the event, through the Effect and the sync surface alike",
    (level: LogLevel) => {
      const { logger, lines } = capture()
      Effect.runSync(logger[level]("probe.started", { attempt: 2 }))
      logger.sync[level]("probe.started", { attempt: 2 })
      expect(lines).toHaveLength(2)
      const expected = { attempt: 2, product: "graph", event: "probe.started", level, msg: "probe.started", org_id: null }
      expect(own(lines[0])).toEqual(expected)
      expect(own(lines[1])).toEqual(expected)
    }
  )

  // admits: a call field re-levels a line, forges its event or product, or files it under another tenant; runtime merge order
  it("a call field cannot spoof level, msg, event, a pinned field or org_id", () => {
    const { logger, lines } = capture()
    // An upstream payload is untyped: `HeraLogFields` refuses `org_id` at the type, so it goes in as one.
    const spread: Record<string, unknown> = { level: "info", msg: "x", event: "fake", product: "evil", org_id: OTHER_ORG }
    logger.sync.warn("probe.failed", { orgId: ORG, ...spread })
    expect(own(lines[0])).toEqual({ level: "warn", msg: "probe.failed", event: "probe.failed", product: "graph", org_id: ORG })
  })

  // admits: a call's orgId re-keys a line whose logger bound an org; runtime slot precedence
  it("an org bound by child wins over a call's orgId", () => {
    const { logger, lines } = capture()
    const bound = logger.child({ orgId: ORG })
    Effect.runSync(bound.error("probe.failed", { orgId: OTHER_ORG }))
    bound.sync.error("probe.failed")
    logger.sync.child({ orgId: ORG }).info("probe.started", { orgId: OTHER_ORG })
    expect(lines.map((l) => l.org_id)).toEqual([ORG, ORG, ORG])
    expect(lines[0]).not.toHaveProperty("orgId")
  })

  // admits: a throwing getter or toJSON escapes the log call into the caller's catch block; a defect no type sees
  it.each([
    ["a getter", () => Object.defineProperty({}, "boom", { enumerable: true, get: () => { throw new Error("getter") } })],
    ["a toJSON", () => ({ cfg: { toJSON: () => { throw new Error("toJSON") } } })],
  ] as const)("%s that throws degrades to a line that still names the event and org", (_label, make) => {
    const { logger, lines } = capture()
    const bound = logger.child({ orgId: ORG })
    expect(() => bound.sync.error("probe.failed", make())).not.toThrow()
    expect(() => Effect.runSync(bound.error("probe.failed", make()))).not.toThrow()
    for (const line of lines) {
      expect(own(line)).toEqual({
        level: "error",
        msg: "probe.failed",
        event: "probe.failed",
        product: "graph",
        org_id: ORG,
        log_error: "unserializable_metadata",
      })
    }
    expect(lines).toHaveLength(2)
  })

  // admits: a throwing sink escapes the log call; a defect no type sees
  it("a sink that throws falls back to a minimal console line, never a throw", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const logger = createHeraLogger({
      service: "graph",
      events: EVENTS,
      sink: () => {
        throw new Error("sink boom")
      },
    }).child({ orgId: ORG })
    expect(() => logger.sync.error("probe.failed", { attempt: 1 })).not.toThrow()
    expect(() => Effect.runSync(logger.error("probe.failed"))).not.toThrow()
    expect(consoleError).toHaveBeenCalledTimes(2)
    const line = JSON.parse(String(consoleError.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(own(line)).toEqual({ level: "error", msg: "probe.failed", event: "probe.failed", org_id: ORG, log_error: "log_write_failed" })
  })

  // admits: a throwing wall clock escapes the sync surface; a defect no type sees
  it("a clock that throws on the sync surface writes the minimal line, never a throw", () => {
    const { logger, lines } = capture()
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock")
    })
    expect(() => logger.child({ orgId: ORG }).sync.warn("probe.failed")).not.toThrow()
    vi.restoreAllMocks()
    expect(lines).toHaveLength(1)
    expect(own(lines[0])).toEqual({ level: "warn", msg: "probe.failed", event: "probe.failed", org_id: ORG, log_error: "log_write_failed" })
  })

  // admits: nothing at runtime; the body is the type rung, and tsc fails on an unused @ts-expect-error (TS2578)
  it("the registry is a type: an unregistered event, a wide registry or a foreign logger is refused", () => {
    const { logger } = capture()
    // @ts-expect-error an event outside the registry
    logger.sync.info("probe.startd")
    // @ts-expect-error an event outside the registry, on the Effect surface
    void logger.warn("probe.startd")
    // @ts-expect-error a wide `string[]` registry would admit every name
    createHeraLogger({ service: "graph", events: EVENTS as ReadonlyArray<string> })
    // @ts-expect-error an `org_id` field: the tenant goes in as `orgId`
    logger.sync.info("probe.started", { org_id: ORG })

    const failed = (slot: HeraEventLoggerSync<Extract<ProbeEvent, "probe.failed">>): void => {
      slot.error("probe.failed")
      // @ts-expect-error a registered event outside the slot's subset
      slot.error("probe.started")
    }
    failed(logger.sync)
    const other = createHeraLogger({ service: "yak", events: ["yak.other"] as const })
    // @ts-expect-error another service's logger does not fill this registry's slot
    failed(other.sync)
    const typed: HeraEventLogger<ProbeEvent> = logger
    expect(typed).toBe(logger)
  })
})
