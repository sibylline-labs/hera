import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import {
  ActorId,
  createHeraLogger,
  Hera,
  HeraCtx,
  HeraTenantCtx,
  type HeraRpcInvokeMeta,
  type LogEntry,
  OrgId,
  RequestId,
} from "../src/index"

// Hera.rpcClient forwards the calling fiber's correlation and trace
// context; Hera.rpcMethod parents its span under the caller's and runs under its request id.
const ULID = "01JAW4B8X7H2M9Q5R8T3V6Y1Z0"
const REQ = RequestId.make(`req_${ULID}`)
const ORG = OrgId.make(`org_${ULID}`)
const ACT = ActorId.make(`act_${ULID}`)
const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/

interface Seen {
  readonly traceId: string
  readonly parentSpanId: string | undefined
  readonly requestId: string
  readonly hasTenant: boolean
  readonly input: unknown
}

function makeCallee() {
  const entries: Array<LogEntry> = []
  const logger = createHeraLogger({ service: "callee", sink: (_l, e) => void entries.push(e) })
  const calls: Array<ReadonlyArray<unknown>> = []
  const method = Hera.rpcMethod({
    name: "probe",
    service: "callee",
    handler: (input: unknown, ctx) =>
      Effect.gen(function* () {
        yield* logger.info("callee.handled")
        const span = yield* Effect.currentSpan
        const tenant = yield* Effect.serviceOption(HeraTenantCtx)
        const seen: Seen = {
          traceId: span.traceId,
          parentSpanId: Option.isSome(span.parent) ? span.parent.value.spanId : undefined,
          requestId: ctx.requestId,
          hasTenant: Option.isSome(tenant),
          input,
        }
        return seen
      }),
  })
  const binding = {
    probe: (...args: ReadonlyArray<unknown>) => {
      calls.push(args)
      return Reflect.apply(method, undefined, [...args])
    },
  }
  return { entries, calls, binding }
}

const callerCtx = HeraCtx.layer({
  requestId: REQ,
  orgId: Option.some(ORG),
  actorId: Option.some(ACT),
  service: "caller",
})

const lastArg = (args: ReadonlyArray<unknown>) => args[args.length - 1] as HeraRpcInvokeMeta

describe("rpcClient → rpcMethod trace and correlation propagation", () => {
  // admits: the meta crosses a runtime call boundary; no type relates the caller fiber to the callee span
  it("the callee span shares the caller's traceId and parents under the client span", async () => {
    const { calls, binding } = makeCallee()
    const client = Hera.rpcClient(binding, { service: "callee", propagate: true })
    const { caller, seen } = await Effect.runPromise(
      Effect.gen(function* () {
        const caller = yield* Effect.currentSpan
        const seen = (yield* client.probe({ q: 1 })) as Seen
        return { caller, seen }
      }).pipe(Effect.withSpan("caller.op"), Effect.provide(callerCtx))
    )
    const sent = lastArg(calls[0]!)
    expect(sent.__heraRpcMeta).toBe(true)
    const match = TP.exec(sent.traceparent ?? "")
    expect(match?.[1]).toBe(caller.traceId)
    expect(seen.traceId).toBe(caller.traceId)
    expect(seen.parentSpanId).toBe(match?.[2])
    expect(seen.input).toEqual({ q: 1 })
  })

  // admits: request id and log slots come from a runtime meta object
  it("a callee with no correlation args runs under the caller's request_id and logs its org_id, without becoming a tenant", async () => {
    const { entries, binding } = makeCallee()
    const client = Hera.rpcClient(binding, { service: "callee", propagate: true })
    const seen = (await Effect.runPromise(
      client.probe({ q: 1 }).pipe(Effect.withSpan("caller.op"), Effect.provide(callerCtx))
    )) as Seen
    expect(seen.requestId).toBe(REQ)
    expect(seen.hasTenant).toBe(false)
    expect(entries[0]?.request_id).toBe(REQ)
    expect(entries[0]?.org_id).toBe(ORG)
    expect(entries[0]?.actor_id).toBe(ACT)
    expect(entries[0]?.trace_id).toBe(seen.traceId)
  })

  // admits: argument positions are a runtime property of the call
  it("a zero-argument call keeps the callee's input undefined", async () => {
    const { binding } = makeCallee()
    const client = Hera.rpcClient(binding, { service: "callee", propagate: true })
    const seen = (await Effect.runPromise(
      client.probe().pipe(Effect.provide(callerCtx))
    )) as Seen
    expect(seen.input).toBeUndefined()
    expect(seen.requestId).toBe(REQ)
  })

  // admits: precedence between two runtime meta objects
  it("an explicit meta argument wins over the ambient one", async () => {
    const { binding } = makeCallee()
    const client = Hera.rpcClient(binding, { service: "callee", propagate: true })
    const other = RequestId.make("req_01JAW4B8X7H2M9Q5R8T3V6Y1Z9")
    const seen = (await Effect.runPromise(
      (client.probe as (i: unknown, m: HeraRpcInvokeMeta) => Effect.Effect<unknown, unknown>)(
        { q: 1 },
        { requestId: other }
      ).pipe(Effect.provide(callerCtx))
    )) as Seen
    expect(seen.requestId).toBe(other)
  })

  // admits: what crosses is a runtime argument list; a callee on an older Hera reads argument two as
  // its tenant-bearing meta and a plain method binds every argument it is given
  it.each([
    { shape: "input only", args: [{ q: 1 }] },
    { shape: "input and an explicit meta", args: [{ q: 1 }, { requestId: REQ }] },
    { shape: "zero arguments", args: [] },
    { shape: "an input org other than the caller's", args: [{ orgId: OrgId.make("org_01JAW4B8X7H2M9Q5R8T3V6Y1Z9") }] },
  ])("a default client sends exactly the caller's arguments: $shape", async ({ args }) => {
    for (const options of [{ service: "callee" }, { service: "callee", propagate: false }] as const) {
      const { calls, binding } = makeCallee()
      const client = Hera.rpcClient(binding, options)
      await Effect.runPromise(
        (client.probe as (...a: Array<unknown>) => Effect.Effect<unknown, unknown>)(...args).pipe(
          Effect.provide(callerCtx),
          Effect.withSpan("caller")
        )
      )
      expect(calls).toEqual([args])
    }
  })

  // admits: a plain binding method's optional parameter is bound by argument position at runtime
  it("a default client leaves a plain method's optional trailing parameter unset", async () => {
    const seen: Array<ReadonlyArray<unknown>> = []
    const binding = {
      connect: (token: string, scopes?: ReadonlyArray<string>) => {
        seen.push([token, scopes])
        return Promise.resolve({ ok: true as const, value: scopes === undefined })
      },
    }
    const client = Hera.rpcClient(binding, { service: "callee" })
    const unset = await Effect.runPromise(
      client.connect("tok").pipe(Effect.provide(callerCtx), Effect.withSpan("caller"))
    )
    expect(unset).toBe(true)
    expect(seen).toEqual([["tok", undefined]])
  })

  // admits: forwarding is a runtime argument shape
  it("a forwarded marked meta is merged, never appended twice", async () => {
    const { calls, binding } = makeCallee()
    const client = Hera.rpcClient(binding, { service: "callee", propagate: true })
    const forwarded = { __heraRpcMeta: true as const, requestId: "req_01JAW4B8X7H2M9Q5R8T3V6Y1Z8" }
    await Effect.runPromise(
      (client.probe as (...a: Array<unknown>) => Effect.Effect<unknown, unknown>)({ q: 1 }, forwarded).pipe(
        Effect.provide(callerCtx)
      )
    )
    expect(calls[0]).toHaveLength(2)
    expect(lastArg(calls[0]!).requestId).toBe(forwarded.requestId)
    expect(lastArg(calls[0]!).orgId).toBe(ORG)
  })

  // admits: a caller-supplied hint is a runtime string from another isolate; no type checks it on arrival
  it("a caller hint that is not a well-formed id never reaches the callee's log line", async () => {
    const { entries, binding } = makeCallee()
    await binding.probe({ q: 1 }, {
      __heraRpcMeta: true,
      orgId: "org_SPOOFED\u001b[31m",
      actorId: "admin",
    } as HeraRpcInvokeMeta)
    expect(entries[0]?.org_id ?? null).toBeNull()
    expect(entries[0]?.actor_id ?? null).toBeNull()
  })

  // admits: what a forwarder passes is a runtime object; only the wire keys may cross
  it("a forwarded marked meta sends only correlation keys, never a callback or tenant shape", async () => {
    const { calls, binding } = makeCallee()
    const client = Hera.rpcClient(binding, { service: "callee", propagate: true })
    const forwarded = { __heraRpcMeta: true as const, onDefect: () => undefined, tenant: { orgId: ORG } }
    await Effect.runPromise(
      (client.probe as (...a: Array<unknown>) => Effect.Effect<unknown, unknown>)({ q: 1 }, forwarded).pipe(
        Effect.provide(callerCtx)
      )
    )
    expect(Object.keys(lastArg(calls[0]!)).sort()).toEqual(
      ["__heraRpcMeta", "actorId", "orgId", "requestId", "traceparent"].sort()
    )
  })

  // admits: the traceparent is a runtime string from another isolate
  it("a malformed traceparent starts a fresh root instead of parenting", async () => {
    const { binding } = makeCallee()
    const bad = "00-00000000000000000000000000000000-b7ad6b7169203331-01"
    const seen = (await binding.probe({ q: 1 }, { __heraRpcMeta: true, traceparent: bad })) as {
      readonly ok: true
      readonly value: Seen
    }
    expect(seen.value.parentSpanId).toBeUndefined()
    expect(seen.value.traceId).not.toBe("00000000000000000000000000000000")
  })

  // admits: baggage travels through a fiber reference; no type sees it reach a sink
  it("baggage is forwarded to the next hop and never written to a log line", async () => {
    const secretish = "k=sensitive-baggage-value"
    const second = makeCallee()
    const secondClient = Hera.rpcClient(second.binding, { service: "callee2", propagate: true })
    const entries: Array<LogEntry> = []
    const logger = createHeraLogger({ service: "hop1", sink: (_l, e) => void entries.push(e) })
    const hop1 = Hera.rpcMethod({
      name: "hop",
      service: "hop1",
      handler: () =>
        Effect.gen(function* () {
          yield* logger.info("hop1.handled")
          return yield* secondClient.probe({ q: 2 })
        }),
    })
    await hop1({ q: 1 }, { __heraRpcMeta: true, baggage: secretish } as HeraRpcInvokeMeta)
    expect(lastArg(second.calls[0]!).baggage).toBe(secretish)
    expect(JSON.stringify(entries)).not.toContain("sensitive-baggage-value")
    expect(JSON.stringify(second.entries)).not.toContain("sensitive-baggage-value")

    const tooLong = `k=${"x".repeat(8200)}`
    const third = makeCallee()
    const thirdClient = Hera.rpcClient(third.binding, { service: "callee3", propagate: true })
    const hop2 = Hera.rpcMethod({ name: "hop", service: "hop2", handler: () => thirdClient.probe({ q: 3 }) })
    await hop2({ q: 1 }, { __heraRpcMeta: true, baggage: tooLong } as HeraRpcInvokeMeta)
    expect(lastArg(third.calls[0]!).baggage).toBeUndefined()
  })
})
