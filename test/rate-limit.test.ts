import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import {
  Hera,
  HeraError,
  type HeraRateLimitBinding,
  type HeraRateLimitBindingOptions,
  HeraRateLimit,
  type LogEntry,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"
import { HeraTest, SAMPLE_IDS } from "../src/testing/index"

const T0 = 1_760_000_000_000

function refusal<A>(exit: Exit.Exit<A, unknown>): HeraError {
  expect(Exit.isFailure(exit)).toBe(true)
  const error = Cause.squash((exit as Exit.Failure<A, unknown>).cause)
  expect(HeraError.is(error)).toBe(true)
  return error as HeraError
}

describe("HeraRateLimit.bucket (pure arithmetic)", () => {
  const b = HeraRateLimit.bucket({ capacity: 10, refillPerSecond: 2 })

  // admits: refill over-fills or a fresh key starts empty; arithmetic over numbers, no type holds it
  it("a never-held bucket is full; refill caps at capacity", () => {
    expect(b.refill(undefined, T0)).toEqual({ tokens: 10, updatedAt: T0 })
    expect(b.refill({ tokens: 9, updatedAt: T0 }, T0 + 60_000)).toEqual({
      tokens: 10,
      updatedAt: T0 + 60_000,
    })
    expect(b.refill({ tokens: 0, updatedAt: T0 }, T0 + 1500).tokens).toBe(3)
  })

  // admits: a backwards clock reading mints or burns tokens; runtime arithmetic
  it("a skewed clock earlier than the stamp adds nothing and keeps the stamp", () => {
    expect(b.refill({ tokens: 1, updatedAt: T0 }, T0 - 5000)).toEqual({
      tokens: 1,
      updatedAt: T0,
    })
  })

  // admits: off-by-one wait (caller retries too early) or debt lost; runtime arithmetic
  it("waitMs is zero when held and rounds up otherwise; take can go negative", () => {
    expect(b.waitMs({ tokens: 1, updatedAt: T0 })).toBe(0)
    expect(b.waitMs({ tokens: 0.5, updatedAt: T0 })).toBe(250)
    expect(b.waitMs({ tokens: 0, updatedAt: T0 }, 3)).toBe(1500)
    expect(b.take({ tokens: 1, updatedAt: T0 }, 3)).toEqual({ tokens: -2, updatedAt: T0 })
  })

  // admits: a float rounding leaves an exhausted bucket short of its stated retry; runtime arithmetic
  it("drained(s) waits exactly s seconds for the next token", () => {
    expect(b.waitMs(b.drained(30, T0))).toBe(30_000)
  })

  // admits: a zero refill rate makes waitMs Infinity/NaN; a number type cannot exclude it
  it("rejects a non-positive or non-finite limit", () => {
    expect(() => HeraRateLimit.bucket({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError)
    expect(() => HeraRateLimit.bucket({ capacity: 1, refillPerSecond: Number.NaN })).toThrow(RangeError)
  })

  // admits: retryAfter 0 tells a client to hammer (AC: retryAfter >= 1); a numeric bound no type holds
  it("refusal rounds up to whole seconds, never below 1", () => {
    expect(HeraRateLimit.refusal(1).retryAfter).toBe(1)
    expect(HeraRateLimit.refusal(1001).retryAfter).toBe(2)
    expect(HeraRateLimit.refusal(0).retryAfter).toBe(1)
    expect(() => HeraRateLimit.refusal(Number.NaN)).toThrow(RangeError)
    expect(() => HeraRateLimit.refusal(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(HeraRateLimit.refusal(0).code).toBe("rate_limited")
  })
})

describe("HeraRateLimit.memory (TestClock)", () => {
  // admits: the TestClock refill and the 429 refusal; runtime behaviour over the Effect Clock
  it("refuses past capacity with rate_limited, retryAfter >= 1, and refills on the clock", async () => {
    const limiter = HeraRateLimit.memory({ capacity: 2, refillPerSecond: 1 })
    const [first, second, third, afterRefill] = await HeraTest.runTest(
      Effect.gen(function* () {
        const a = yield* Effect.exit(limiter.take())
        const b = yield* Effect.exit(limiter.take())
        const c = yield* Effect.exit(limiter.take())
        yield* HeraTest.advanceClock("1 second")
        const d = yield* Effect.exit(limiter.take())
        return [a, b, c, d] as const
      }),
      HeraTest.layer()
    )
    expect(Exit.isSuccess(first)).toBe(true)
    expect(Exit.isSuccess(second)).toBe(true)
    const error = refusal(third)
    expect(error.code).toBe("rate_limited")
    expect(error.httpStatus).toBe(429)
    expect(error.retryAfter).toBe(1)
    expect(Exit.isSuccess(afterRefill)).toBe(true)
  })

  // admits: two fibers both spend the last token; a scheduling property
  it("two concurrent takes on the last token admit exactly one", async () => {
    const limiter = HeraRateLimit.memory({ capacity: 1, refillPerSecond: 1 })
    const exits = await HeraTest.runTest(
      Effect.all([Effect.exit(limiter.take()), Effect.exit(limiter.take())], {
        concurrency: "unbounded",
      }),
      HeraTest.layer()
    )
    expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
  })

  // admits: a spend that can never admit returns a misleading retryAfter instead of a defect; runtime check
  it("a spend larger than capacity dies with RangeError", async () => {
    const limiter = HeraRateLimit.memory({ capacity: 2, refillPerSecond: 1 })
    const exit = await HeraTest.runTestExit(limiter.take(3), HeraTest.layer())
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })
})

class LimitedDO extends Hera.TenantDurableObject.configure({ service: "limited", migrations: [] }) {
  spend(key: string, now: number, table?: string) {
    return Effect.runSyncExit(
      this.db.transactSync((tx) =>
        HeraRateLimit.sqlStore(tx, key, { capacity: 2, refillPerSecond: 1, now, table })
      )
    )
  }
}

type StateHarness = ReturnType<typeof makeTestDurableObjectState>

function stored(h: StateHarness, table = "hera_rate_limit_buckets") {
  return h.sqliteDb.prepare(`SELECT key, tokens, updated_at FROM ${table} ORDER BY key`).all()
}

describe("HeraRateLimit.sqlStore (SyncTx-backed)", () => {
  // admits: a refusal persists partial state or an eviction resets the budget; SQLite rollback and persistence are runtime
  it("refuses past capacity, writes nothing on a refusal, and survives an eviction", () => {
    const h = makeTestDurableObjectState({ idName: SAMPLE_IDS.orgId })
    const first = new LimitedDO(h.state, {})
    expect(Exit.isSuccess(first.spend("token:a", T0))).toBe(true)
    expect(Exit.isSuccess(first.spend("token:a", T0))).toBe(true)
    const before = stored(h)
    const error = refusal(first.spend("token:a", T0))
    expect(error.code).toBe("rate_limited")
    expect(error.retryAfter).toBe(1)
    expect(stored(h)).toEqual(before)

    // Eviction: a new instance over the same SQLite keeps the drained bucket.
    const h2 = makeTestDurableObjectState({ idName: SAMPLE_IDS.orgId, sqliteDb: h.sqliteDb })
    const second = new LimitedDO(h2.state, {})
    expect(refusal(second.spend("token:a", T0)).code).toBe("rate_limited")
    expect(Exit.isSuccess(second.spend("token:a", T0 + 1000))).toBe(true)
    expect(Exit.isSuccess(second.spend("token:b", T0))).toBe(true)
  })

  // admits: accounts L2 token+product pair spends one bucket when the other refuses; transaction rollback is runtime
  it("two keys spent in one transaction are admitted together or not at all", () => {
    const h = makeTestDurableObjectState({ idName: SAMPLE_IDS.orgId })
    const tenant = new LimitedDO(h.state, {})
    tenant.spend("product:yak", T0)
    tenant.spend("product:yak", T0)
    const exit = Effect.runSyncExit(
      tenant.db.transactSync((tx) =>
        tx.gen(function* () {
          yield* HeraRateLimit.sqlStore(tx, "token:a", { capacity: 2, refillPerSecond: 1, now: T0 })
          yield* HeraRateLimit.sqlStore(tx, "product:yak", { capacity: 2, refillPerSecond: 1, now: T0 })
        })
      )
    )
    expect(refusal(exit).code).toBe("rate_limited")
    expect(stored(h).map((r) => (r as { key: string }).key)).toEqual(["product:yak"])
  })

  // admits: SQL injection through the table identifier, or accounts losing its existing buckets rows; the identifier is a runtime string
  it("keeps rows in a named table of the same shape, and refuses an unsafe table name", () => {
    const h = makeTestDurableObjectState({ idName: SAMPLE_IDS.orgId })
    const tenant = new LimitedDO(h.state, {})
    expect(Exit.isSuccess(tenant.spend("token:a", T0, "buckets"))).toBe(true)
    expect(stored(h, "buckets")).toEqual([{ key: "token:a", tokens: 1, updated_at: T0 }])
    const bad = tenant.spend("token:a", T0, "buckets; DROP TABLE buckets")
    expect(Exit.isFailure(bad) && Cause.hasDies(bad.cause)).toBe(true)
    expect(stored(h, "buckets")).toHaveLength(1)
    for (const exit of [
      Effect.runSyncExit(tenant.db.transactSync((tx) =>
        HeraRateLimit.sqlStore(tx, "k", { capacity: 0, refillPerSecond: 1, now: T0 }))),
      Effect.runSyncExit(tenant.db.transactSync((tx) =>
        HeraRateLimit.sqlStore(tx, "k", { capacity: 2, refillPerSecond: 1, now: Number.POSITIVE_INFINITY }))),
    ]) {
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }
    expect(h.sqliteDb.prepare("SELECT name FROM sqlite_master WHERE name = 'hera_rate_limit_buckets'").all()).toEqual([])
  })

})

describe("HeraRateLimit.binding (Cloudflare RateLimit)", () => {
  const run = (limiter: HeraRateLimitBinding | undefined, options?: HeraRateLimitBindingOptions) => {
    const logs: Array<LogEntry> = []
    const exit = HeraTest.runTestExit(
      HeraRateLimit.binding(limiter, "sib_org", { ...options, logEvent: "gateway.l1_unavailable" }),
      HeraTest.layer({ sink: (_line, entry) => logs.push(entry) })
    )
    return exit.then((e) => ({ exit: e, logs }))
  }

  // admits: binding refusal without Retry-After, or the period option ignored; external binding behaviour
  it("admits on success and refuses with the period as retryAfter", async () => {
    expect(Exit.isSuccess((await run({ limit: async () => ({ success: true }) })).exit)).toBe(true)
    const refused = await run({ limit: async () => ({ success: false }) })
    expect(refusal(refused.exit).retryAfter).toBe(60)
    const tenSeconds = await run({ limit: async () => ({ success: false }) }, { retryAfterSeconds: 10 })
    expect(refusal(tenSeconds.exit).retryAfter).toBe(10)
    const nan = await run({ limit: async () => ({ success: false }) }, { retryAfterSeconds: Number.NaN })
    expect(Exit.isFailure(nan.exit) && Cause.hasDies(nan.exit.cause)).toBe(true)
  })

  // admits: a down or missing binding blocks all traffic, logs per retry, or leaks the key; external binding behaviour
  it("fails open and logs once when the binding throws or is missing", async () => {
    for (const limiter of [
      { limit: async () => { throw new Error("binding down") } },
      undefined,
    ] as ReadonlyArray<HeraRateLimitBinding | undefined>) {
      const { exit, logs } = await run(limiter)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(logs.filter((l) => l.msg === "gateway.l1_unavailable")).toHaveLength(1)
      expect(JSON.stringify(logs)).not.toContain("sib_org")
    }
  })

  const unavailable: ReadonlyArray<HeraRateLimitBinding | undefined> = [
    { limit: async () => { throw new Error("binding down") } },
    undefined,
  ]

  // admits: a fail-closed caller admitted on a down or missing binding, or the caller's code lost
  it("refuses 503 with the caller's code and logs once when the binding throws or is missing", async () => {
    for (const limiter of unavailable) {
      const { exit, logs } = await run(limiter, {
        onUnavailable: "refuse",
        code: "gates_unavailable",
        publicMessage: "The gates budget is unavailable",
      })
      const error = refusal(exit)
      expect(error.httpStatus).toBe(503)
      expect(error.code).toBe("gates_unavailable")
      expect(error.publicMessage).toBe("The gates budget is unavailable")
      expect(logs.filter((l) => l.msg === "gateway.l1_unavailable")).toHaveLength(1)
      expect(JSON.stringify(logs)).not.toContain("sib_org")
    }
  })

  // admits: refuse mode with no code answering anything but the catalog's 503
  it("refuses with service_unavailable by default, and refuse mode still counts an available binding", async () => {
    const error = refusal((await run(undefined, { onUnavailable: "refuse" })).exit)
    expect([error.httpStatus, error.code, error.publicMessage]).toEqual([503, "service_unavailable", "Service unavailable"])
    const ok = await run({ limit: async () => ({ success: true }) }, { onUnavailable: "refuse" })
    expect(Exit.isSuccess(ok.exit)).toBe(true)
    const limited = await run({ limit: async () => ({ success: false }) }, { onUnavailable: "refuse" })
    expect(refusal(limited.exit).code).toBe("rate_limited")
    // @ts-expect-error code is a refuse-mode option only
    const admitWithCode: HeraRateLimitBindingOptions = { onUnavailable: "admit", code: "gates_unavailable" }
    expect(admitWithCode.onUnavailable).toBe("admit")
    const prebuilt = { code: "gates_unavailable" as const, logEvent: "x" }
    // @ts-expect-error a pre-built object carrying code is still refused outside refuse mode
    void HeraRateLimit.binding(undefined, "k", prebuilt)
  })
})
