import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import { describe, expect, it } from "vitest"
import {
  ActorId,
  createHeraLogger,
  Hera,
  HeraAuthedCtx,
  HeraPublicCtx,
  HeraTenantCtx,
  CurrentLogCorrelation,
  type LogEntry,
  OrgId,
  RequestId,
} from "../src/index"

// A logger bound to nothing fills its correlation slots from the Hera ctx
// in the fiber and writes the active span's W3C ids.
const ULID = "01JAW4B8X7H2M9Q5R8T3V6Y1Z0"
const REQ = RequestId.make(`req_${ULID}`)
const ORG = OrgId.make(`org_${ULID}`)
const ACT = ActorId.make(`act_${ULID}`)
const OTHER_ORG = OrgId.make("org_01JAW4B8X7H2M9Q5R8T3V6Y1Z9")

function capture(options: { readonly orgId?: OrgId } = {}) {
  const entries: Array<LogEntry> = []
  const logger = createHeraLogger({
    service: "ambient-test",
    ...options,
    sink: (_line, entry) => void entries.push(entry),
  })
  return { entries, logger }
}

const W3C_TRACE = /^[0-9a-f]{32}$/
const W3C_SPAN = /^[0-9a-f]{16}$/

describe("readFiberAmbient derives correlation from the Hera ctx", () => {
  // admits: the slot is filled from a runtime service lookup; no type relates a ctx layer to a sink line
  it("a Hera.fn under HeraTenantCtx writes org, actor, request, actor_kind and W3C ids with no explicit args", async () => {
    const { entries, logger } = capture()
    const op = Hera.fn("Ambient.tenantOp")(function* () {
      yield* logger.warn("ambient.tenant")
    })
    await Effect.runPromise(
      op().pipe(
        Effect.provide(
          HeraTenantCtx.layer({ orgId: ORG, requestId: REQ, actorId: ACT, actorKind: "user", service: "svc" })
        )
      )
    )
    const entry = entries[0]!
    expect(entry.org_id).toBe(ORG)
    expect(entry.actor_id).toBe(ACT)
    expect(entry.request_id).toBe(REQ)
    expect(entry.actor_kind).toBe("user")
    expect(entry.trace_id).toMatch(W3C_TRACE)
    expect(entry.span_id).toMatch(W3C_SPAN)
    expect(entry.span).toBe("Ambient.tenantOp")
  })

  // admits: as above, over the authed ctx a Hera.authedRoute provides
  it("HeraAuthedCtx fills the slots and the span ids match the active span", async () => {
    const { entries, logger } = capture()
    let ids: { traceId: string; spanId: string } | undefined
    const program = Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      ids = { traceId: span.traceId, spanId: span.spanId }
      yield* logger.warn("ambient.authed")
    }).pipe(Effect.withSpan("authed.op"))
    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          HeraAuthedCtx.layer({ requestId: REQ, service: "svc", orgId: ORG, actorId: ACT, actorKind: "service" })
        )
      )
    )
    const entry = entries[0]!
    expect([entry.org_id, entry.actor_id, entry.request_id, entry.actor_kind]).toEqual([ORG, ACT, REQ, "service"])
    expect(entry.trace_id).toBe(ids?.traceId)
    expect(entry.span_id).toBe(ids?.spanId)
  })

  // admits: precedence between a bound slot and an ambient one is a runtime merge order
  it("a slot the logger bound wins over the ambient ctx", async () => {
    const { entries, logger } = capture({ orgId: OTHER_ORG })
    await Effect.runPromise(
      logger.info("bound.wins").pipe(
        Effect.provide(HeraTenantCtx.layer({ orgId: ORG, requestId: REQ, actorId: Option.none(), service: "svc" }))
      )
    )
    expect(entries[0]!.org_id).toBe(OTHER_ORG)
    expect(entries[0]!.request_id).toBe(REQ)
    expect(entries[0]!.actor_id).toBeNull()
  })

  // admits: HeraPublicCtx carries a request id only
  it("HeraPublicCtx fills request_id and leaves org and actor null", async () => {
    const { entries, logger } = capture()
    await Effect.runPromise(
      logger.info("public").pipe(Effect.provide(HeraPublicCtx.layer({ requestId: REQ, service: "svc" })))
    )
    expect([entries[0]!.request_id, entries[0]!.org_id, entries[0]!.actor_id]).toEqual([REQ, null, null])
    expect("actor_kind" in entries[0]!).toBe(false)
  })

  // admits: a correlation another logger bound into the fiber (`child(...).layer`) reaches this one
  it("a correlation slot bound by another logger's layer fills this logger's slot", async () => {
    const { entries, logger } = capture()
    const bound = createHeraLogger({ service: "other" }).child({ orgId: ORG, requestId: REQ })
    await Effect.runPromise(logger.info("via.layer").pipe(Effect.provide(bound.layer)))
    expect([entries[0]!.org_id, entries[0]!.request_id]).toEqual([ORG, REQ])
  })

  // admits: reserved keys are a runtime filter over untyped metadata
  it("writes no trace ids outside a span, and a call cannot spoof them", async () => {
    const { entries, logger } = capture()
    await Effect.runPromise(logger.info("no.span", { trace_id: "spoofed", span_id: "spoofed", actor_kind: "admin" }))
    expect("trace_id" in entries[0]!).toBe(false)
    expect("span_id" in entries[0]!).toBe(false)
    expect("actor_kind" in entries[0]!).toBe(false)
  })

  // admits: ambient values reach the line head, past the field scrubber; a caller-provided
  // reference or a propagated span can carry any string at runtime
  it("scrubs an ambient slot and drops a span id that is not W3C-shaped", async () => {
    const { entries, logger } = capture()
    const credential = "f".repeat(64)
    const external = Tracer.externalSpan({ traceId: `sib_${credential}`, spanId: "not-hex" })
    await Effect.runPromise(
      logger.info("hostile.ambient").pipe(
        Effect.withParentSpan(external),
        Effect.provide(Layer.succeed(CurrentLogCorrelation, { requestId: credential }))
      )
    )
    expect(entries[0]!.request_id).toBe("[REDACTED]")
    expect(JSON.stringify(entries[0])).not.toContain(credential)
    expect("trace_id" in entries[0]!).toBe(false)
    expect("span_id" in entries[0]!).toBe(false)
  })
})

describe("HeraEventLogger.sync inside a fiber", () => {
  // admits: the ambient is read from a runtime fiber slot; no type relates a sync call site to its fiber
  it("a .sync line written from a callback inside a traced ctx fiber carries that fiber's correlation", async () => {
    const lines: Array<LogEntry> = []
    const logger = createHeraLogger({
      service: "ambient-test",
      events: ["cb.failed"] as const,
      sink: (_line, entry) => void lines.push(entry),
    })
    const op = Hera.fn("Ambient.syncOp")(function* () {
      yield* Effect.sync(() => logger.sync.warn("cb.failed"))
    })
    await Effect.runPromise(
      op().pipe(
        Effect.provide(
          HeraTenantCtx.layer({ orgId: ORG, requestId: REQ, actorId: ACT, actorKind: "user", service: "svc" })
        )
      )
    )
    const entry = lines[0]!
    expect(entry.request_id).toBe(REQ)
    expect(entry.org_id).toBe(ORG)
    expect(entry.trace_id).toMatch(W3C_TRACE)
    expect(entry.span_id).toMatch(W3C_SPAN)
  })

  // admits: outside any fiber the slot is empty; the unchanged-path claim is runtime behaviour
  it("a .sync line outside any fiber carries no ambient correlation", () => {
    const lines: Array<LogEntry> = []
    const logger = createHeraLogger({
      service: "ambient-test",
      events: ["cb.failed"] as const,
      sink: (_line, entry) => void lines.push(entry),
    })
    logger.sync.warn("cb.failed")
    expect(lines[0]!.request_id).toBeFalsy()
    expect(lines[0]!.trace_id).toBeFalsy()
  })
})
