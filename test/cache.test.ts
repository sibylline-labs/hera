import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import { HeraCache, HeraTenantCtx } from "../src/index"
import { HeraTest } from "../src/testing/index"

const run = <A, E>(effect: Effect.Effect<A, E>) => HeraTest.runTest(effect, HeraTest.layer())

/** A lookup that records each key it is asked for and answers after 10ms of (virtual) time:
 *  `bad*` fails with a typed error, `die*` dies, anything else answers its length. */
function counting() {
  const calls: string[] = []
  const lookup = (key: string): Effect.Effect<number, string> =>
    Effect.suspend(() => {
      calls.push(key)
      if (key.startsWith("bad")) return Effect.fail(`no ${key}`)
      if (key.startsWith("die")) return Effect.die(new Error(`boom ${key}`))
      return Effect.sleep("10 millis").pipe(Effect.as(key.length))
    })
  return { calls, lookup }
}

/** Forks `effect`, advances the clock past the lookup's 10ms, and joins it. */
const settle = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    yield* HeraTest.advanceClock("20 millis")
    return yield* Fiber.join(fiber)
  })

describe("HeraCache", () => {
  // admits: algorithmic: a get that waits on another caller's lookup (on workerd it is resumed in that caller's
  // request and cancelled as hung), or a hit within the TTL that looks up again
  it("concurrent misses each look up in their own fiber, and a hit within the TTL looks up nothing", async () => {
    const { calls, lookup } = counting()
    const cache = HeraCache.make({ ttlMs: 60_000, lookup })
    const got = await run(
      Effect.gen(function* () {
        const both = yield* settle(Effect.all([cache.get("ab"), cache.get("ab")], { concurrency: "unbounded" }))
        yield* HeraTest.advanceClock("59 seconds")
        const hit = yield* cache.get("ab")
        return { both, hit }
      })
    )
    expect(got).toEqual({ both: [2, 2], hit: 2 })
    expect(calls).toEqual(["ab", "ab"])
  })

  // admits: an entry that never expires, or one that expires early
  it("looks up again once the TTL has passed", async () => {
    const { calls, lookup } = counting()
    const cache = HeraCache.make({ ttlMs: 60_000, lookup })
    await run(
      Effect.gen(function* () {
        // The lookup completes at t=10ms and the TTL runs from then; settle leaves the clock at 20ms.
        yield* settle(cache.get("ab"))
        yield* HeraTest.advanceClock(59_989)
        yield* cache.get("ab")
        expect(calls).toEqual(["ab"])
        yield* HeraTest.advanceClock(1)
        yield* settle(cache.get("ab"))
      })
    )
    expect(calls).toEqual(["ab", "ab"])
  })

  // admits: a failure retried on every get, or held for the success TTL when negativeTtlMs is set
  it("holds a typed failure for negativeTtlMs, then retries", async () => {
    const { calls, lookup } = counting()
    const cache = HeraCache.make({ ttlMs: 60_000, negativeTtlMs: 5_000, lookup })
    const exits = await run(
      Effect.gen(function* () {
        const first = yield* Effect.flip(cache.get("bad"))
        const held = yield* Effect.flip(cache.get("bad"))
        yield* HeraTest.advanceClock("5 seconds")
        const retried = yield* Effect.flip(cache.get("bad"))
        return [first, held, retried]
      })
    )
    expect(exits).toEqual(["no bad", "no bad", "no bad"])
    expect(calls).toEqual(["bad", "bad"])
  })

  // admits: a default negative TTL other than ttlMs
  it("holds a failure for ttlMs when negativeTtlMs is not given", async () => {
    const { calls, lookup } = counting()
    const cache = HeraCache.make({ ttlMs: 60_000, lookup })
    await run(
      Effect.gen(function* () {
        yield* Effect.exit(cache.get("bad"))
        yield* HeraTest.advanceClock(59_999)
        yield* Effect.exit(cache.get("bad"))
        expect(calls).toEqual(["bad"])
        yield* HeraTest.advanceClock(1)
        yield* Effect.exit(cache.get("bad"))
      })
    )
    expect(calls).toEqual(["bad", "bad"])
  })

  // admits: negativeTtlMs 0 still holding a failure, or a defect being held
  it.each([
    ["a typed failure with negativeTtlMs 0", "bad", 0],
    ["a defect", "die", undefined],
  ] as const)("never holds %s", async (_label, key, negativeTtlMs) => {
    const { calls, lookup } = counting()
    const cache = HeraCache.make({ ttlMs: 60_000, negativeTtlMs, lookup })
    await run(
      Effect.gen(function* () {
        yield* Effect.exit(cache.get(key))
        yield* Effect.exit(cache.get(key))
      })
    )
    expect(calls).toEqual([key, key])
  })

  // admits: insertion-order (FIFO) eviction, or no eviction at the cap
  it("evicts the least recently used entry at maxEntries", async () => {
    const { calls, lookup } = counting()
    const cache = HeraCache.make({ ttlMs: 60_000, maxEntries: 2, lookup })
    await run(
      Effect.gen(function* () {
        for (const key of ["a", "bb", "a", "ccc", "a", "bb"]) yield* settle(cache.get(key))
      })
    )
    // `a` was refreshed by its hit, so `ccc` evicted `bb`; `a` was never looked up again.
    expect(calls).toEqual(["a", "bb", "ccc", "bb"])
  })

  // admits: invalidate dropping other keys, clear leaving any, or an in-flight caller losing its answer
  it("invalidate drops one key, clear drops all, and a lookup in flight still answers and is held", async () => {
    const { calls, lookup } = counting()
    const cache = HeraCache.make({ ttlMs: 60_000, lookup })
    const inFlight = await run(
      Effect.gen(function* () {
        yield* settle(cache.get("a"))
        yield* settle(cache.get("bb"))
        yield* cache.invalidate("a")
        yield* settle(cache.get("a"))
        yield* cache.get("bb")
        expect(calls).toEqual(["a", "bb", "a"])
        yield* cache.clear()
        yield* settle(cache.get("a"))
        yield* settle(cache.get("bb"))
        expect(calls).toEqual(["a", "bb", "a", "a", "bb"])
        const waiter = yield* Effect.forkChild(cache.get("dddd"))
        yield* Effect.yieldNow
        yield* cache.invalidate("dddd")
        yield* HeraTest.advanceClock("20 millis")
        const answer = yield* Fiber.join(waiter)
        yield* settle(cache.get("dddd"))
        return answer
      })
    )
    expect(inFlight).toBe(4)
    expect(calls.filter((key) => key === "dddd")).toHaveLength(1)
  })

  // admits: an interrupted lookup cached as an interruption
  it("does not hold a lookup whose only waiter was interrupted", async () => {
    const { calls, lookup } = counting()
    const cache = HeraCache.make({ ttlMs: 60_000, lookup })
    const got = await run(
      Effect.gen(function* () {
        const waiter = yield* Effect.forkChild(cache.get("ab"))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(waiter)
        return yield* settle(cache.get("ab"))
      })
    )
    expect(got).toBe(2)
    expect(calls).toEqual(["ab", "ab"])
  })

  // admits: a cache built with a TTL or cap it cannot honour
  it.each([
    ["ttlMs 0", { ttlMs: 0 }],
    ["ttlMs NaN", { ttlMs: Number.NaN }],
    ["ttlMs Infinity", { ttlMs: Number.POSITIVE_INFINITY }],
    ["negativeTtlMs -1", { ttlMs: 1_000, negativeTtlMs: -1 }],
    ["negativeTtlMs NaN", { ttlMs: 1_000, negativeTtlMs: Number.NaN }],
    ["maxEntries 0", { ttlMs: 1_000, maxEntries: 0 }],
    ["maxEntries 1.5", { ttlMs: 1_000, maxEntries: 1.5 }],
  ])("refuses %s with a RangeError", (_label, options) => {
    expect(() => HeraCache.make({ ...options, lookup: (key: string) => Effect.succeed(key) })).toThrow(RangeError)
  })

  // admits: the cache keeping its first caller's services and lending them to a later lookup
  it("does not lend the first caller's services to a later caller's lookup", async () => {
    class Tenant extends Context.Service<Tenant, string>()("test/Tenant") {}
    const cache = HeraCache.make({
      ttlMs: 60_000,
      lookup: (key: string) =>
        Effect.map(Effect.serviceOption(Tenant), (tenant) => `${key}<-${Option.getOrElse(tenant, () => "none")}`),
    })
    const seen = await run(
      Effect.gen(function* () {
        const first = yield* cache.get("k1").pipe(Effect.provide(Layer.succeed(Tenant, "tenant-A")))
        const later = yield* cache.get("k2")
        return [first, later]
      })
    )
    expect(seen).toEqual(["k1<-tenant-A", "k2<-none"])
  })

  // admits: a lookup that reads a caller's service, whose held answer would be served to every later caller
  it("refuses, at the type level, a lookup that requires a service", () => {
    const cache = HeraCache.make({
      ttlMs: 1_000,
      // @ts-expect-error a lookup's R must be never: put the tenant in the key
      lookup: (_key: string) => HeraTenantCtx.current,
    })
    expect(typeof cache.get).toBe("function")
  })
})
