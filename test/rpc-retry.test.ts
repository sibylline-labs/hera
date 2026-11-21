import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Random from "effect/Random"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import {
  Hera,
  HeraError,
  type HeraRpcRetryNotice,
  isRetryableTransportError,
} from "../src/index"

const lost = () => new Error("Network connection lost.")

/** Lets the forked call's promise settle (a real macrotask; virtual time does not move). */
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

/** Runs `effect` under a seeded `Random` and a `TestClock`, as a forked fiber the test drives. */
const runVirtual = <A, E>(
  body: (fiber: Fiber.Fiber<A, E>) => Effect.Effect<void>,
  effect: Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect)
      yield* body(fiber)
      return yield* Fiber.await(fiber)
    }).pipe(Random.withSeed("rpc-retry-jitter"), Effect.provide(TestClock.layer()))
  )

describe("Hera.rpcClient retry policy", () => {
  // admits: retries firing without backoff, or on wall-clock timers; a sleep on the Effect Clock is runtime behaviour no type sees
  it("retries a transient transport error with backoff on the TestClock, then succeeds", async () => {
    let calls = 0
    const notices: Array<HeraRpcRetryNotice> = []
    const binding = {
      async push(_n: number) {
        calls++
        if (calls < 3) throw lost()
        return { ok: true as const, value: "applied" }
      },
    }
    const client = Hera.rpcClient(() => binding, {
      service: "graph",
      retry: {
        attempts: 3,
        backoff: { baseMs: 100, maxMs: 1000 },
        onRetry: (n) => notices.push(n),
      },
    })

    const exit = await runVirtual((fiber) =>
      Effect.gen(function* () {
        yield* settle
        expect(calls).toBe(1)
        expect(notices).toHaveLength(1)
        // Full jitter: the first delay is < baseMs; nothing runs before the clock moves.
        expect(notices[0]!.backoffMs).toBeLessThan(100)
        yield* TestClock.adjust(notices[0]!.backoffMs)
        yield* settle
        expect(calls).toBe(2)
        expect(notices).toHaveLength(2)
        expect(notices[1]!.backoffMs).toBeLessThan(200)
        yield* TestClock.adjust(notices[1]!.backoffMs)
        void fiber
      }), client.push(1))

    expect(exit._tag).toBe("Success")
    expect(calls).toBe(3)
    expect(notices.map((n) => [n.service, n.method, n.attempt, n.errorName, n.timedOut])).toEqual([
      ["graph", "push", 1, "Error", false],
      ["graph", "push", 2, "Error", false],
    ])
  })

  // admits: an unbounded or off-by-one retry loop and a lost 503 mapping; attempt counting is runtime behaviour
  it("stops after `attempts` and surfaces 503 <service>_unavailable with fields.attempts", async () => {
    let calls = 0
    const client = Hera.rpcClient(
      {
        async push() {
          calls++
          throw lost()
        },
      },
      { service: "accounts", retry: { attempts: 3 } }
    )

    const exit = await runVirtual(() => TestClock.adjust("10 seconds"), Effect.flip(client.push()))

    expect(calls).toBe(3)
    expect(exit._tag).toBe("Success")
    const err = exit._tag === "Success" ? exit.value : undefined
    expect(HeraError.is(err)).toBe(true)
    expect(err?.status).toBe(503)
    expect(err?.code).toBe("accounts_unavailable")
    expect(err?.fields).toEqual({
      service: "accounts",
      method: "push",
      retryable: true,
      attempts: 3,
      timedOut: false,
    })
  })

  // admits: a retry that re-sends after a deterministic refusal (AC 2); the refusal is a returned value, so only execution shows it
  it("never retries a domain refusal ({ ok: false } envelope)", async () => {
    let calls = 0
    const client = Hera.rpcClient(
      {
        async verify() {
          calls++
          return { ok: false as const, status: 404 as const, code: "not_found" as const, error: "not_found" as const, message: "nope" }
        },
      },
      { service: "accounts", retry: { attempts: 5, isRetryable: () => true } }
    )

    const exit = await runVirtual(() => TestClock.adjust("1 minute"), Effect.flip(client.verify()))

    expect(calls).toBe(1)
    const err = exit._tag === "Success" ? exit.value : undefined
    expect(err?.code).toBe("not_found")
    expect(err?.status).toBe(404)
  })

  // admits: a hung stub holding the request forever, and a timeout not mapped to 503 (AC 3); timing is runtime-only
  it("times out an attempt that never settles, retries it, and surfaces service_unavailable", async () => {
    let calls = 0
    const client = Hera.rpcClient(
      {
        push() {
          calls++
          return new Promise<never>(() => {})
        },
      },
      { retry: { attempts: 2, timeoutMs: 1000, backoff: { baseMs: 10, maxMs: 10 } } }
    )

    const exit = await runVirtual(
      () =>
        Effect.gen(function* () {
          yield* TestClock.adjust(1000)
          yield* TestClock.adjust(10)
          yield* TestClock.adjust(1000)
        }),
      Effect.flip(client.push())
    )

    expect(calls).toBe(2)
    const err = exit._tag === "Success" ? exit.value : undefined
    expect(err?.code).toBe("service_unavailable")
    expect(err?.status).toBe(503)
    expect(err?.fields).toMatchObject({ attempts: 2, timedOut: true })
  })

  // admits: retrying an overloaded or remote-thrown error, or ignoring a caller predicate; flags on a thrown value are runtime data
  it("does not retry overloaded or remote errors, nor what a custom isRetryable refuses", async () => {
    const overloaded = Object.assign(new Error("Durable Object is overloaded."), { overloaded: true })
    const remote = Object.assign(new Error("boom"), { remote: true })
    for (const [thrown, isRetryable] of [
      [overloaded, undefined],
      [remote, undefined],
      [lost(), () => false],
    ] as const) {
      let calls = 0
      const client = Hera.rpcClient(
        {
          async push() {
            calls++
            throw thrown
          },
        },
        { retry: { attempts: 4, ...(isRetryable ? { isRetryable } : {}) } }
      )
      await runVirtual(() => TestClock.adjust("1 minute"), Effect.flip(client.push()))
      expect(calls).toBe(1)
    }
  })

  // admits: a locally thrown HeraError (a refusal) being retried because its public message matches a transient pattern
  it("never retries a thrown HeraError, whatever the predicate says", async () => {
    let calls = 0
    const client = Hera.rpcClient(
      {
        async push() {
          calls++
          throw new HeraError({ code: "not_found", httpStatus: 404, publicMessage: "disconnected record" })
        },
      },
      { retry: { attempts: 4, isRetryable: () => true } }
    )

    const exit = await runVirtual(() => TestClock.adjust("1 minute"), Effect.flip(client.push()))

    expect(calls).toBe(1)
    const err = exit._tag === "Success" ? exit.value : undefined
    expect(err?.fields).toMatchObject({ retryable: false, attempts: 1 })
  })

  // admits: retrying into a broken stub; whether the thunk is re-invoked is runtime behaviour
  it("resolves the binding thunk once per attempt (a fresh stub each time)", async () => {
    let built = 0
    let calls = 0
    const client = Hera.rpcClient(
      () => {
        built++
        return {
          async push() {
            calls++
            if (calls < 2) throw lost()
            return "raw"
          },
        }
      },
      { retry: { attempts: 3, backoff: { baseMs: 1, maxMs: 1 } } }
    )

    const exit = await runVirtual(() => TestClock.adjust(1), client.push())

    expect(exit._tag).toBe("Success")
    expect(built).toBe(2)
  })
})

describe("isRetryableTransportError (Cloudflare error flags)", () => {
  // admits: a flag-precedence regression in the default predicate; flags on thrown values are runtime data
  it("refuses overloaded, honours retryable over remote, refuses remote, matches transient messages", () => {
    expect(isRetryableTransportError(Object.assign(new Error("x"), { overloaded: true, retryable: true }))).toBe(false)
    expect(isRetryableTransportError(new Error("Durable Object is overloaded."))).toBe(false)
    expect(isRetryableTransportError(Object.assign(new Error("x"), { retryable: true, remote: true }))).toBe(true)
    expect(isRetryableTransportError(Object.assign(new Error("Network connection lost."), { remote: true }))).toBe(false)
    expect(isRetryableTransportError(lost())).toBe(true)
    expect(isRetryableTransportError(new Error("TypeError: bad input"))).toBe(false)
  })
})
