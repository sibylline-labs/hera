import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { HERA_DIALS_DEFAULT_TIMEOUT_MS, type HeraDialReaderKey } from "../src/core/config/index"
import { HeraConfig } from "../src/index"
import { HeraTest } from "../src/testing/index"

const BASE = "https://logfire.test"
const DEFAULTS = { batch: 25, retry_ms: 60_000, limit: { capacity: 600, refillPerSecond: 10 } }
type Group = typeof DEFAULTS
const Positive = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))
const Overrides = Schema.Struct({
  batch: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  retry_ms: Schema.optional(Positive),
  limit: Schema.optional(Schema.Struct({ capacity: Positive, refillPerSecond: Positive })),
})
const GROUP = HeraConfig.dials<Group, typeof Overrides>({ name: "dials_test", defaults: DEFAULTS, overrides: Overrides })
const OTHER = HeraConfig.dials<Group, typeof Overrides>({ name: "dials_other", defaults: DEFAULTS, overrides: Overrides })

type Answer = (init: RequestInit | undefined) => Response | Promise<Response>

/** A Logfire that answers every read with `answer` and records each URL it was asked for. */
function logfire(answer: Answer, readerTimeoutMs?: number) {
  const calls: string[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input))
    return answer(init)
  }) as typeof globalThis.fetch
  return { calls, readers: HeraConfig.dialReaders({ fetch, timeoutMs: readerTimeoutMs }) }
}

const serves = (value: unknown): Answer => () =>
  new Response(JSON.stringify({ name: "x", latest_version: { version: 1, serialized_value: JSON.stringify(value) } }), {
    status: 200,
  })
const status = (code: number, body = "{}"): Answer => () => new Response(body, { status: code })
/** Like workerd's `fetch`, rejects only when the request is aborted. */
const hangs: Answer = (init) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))

const key = (token = "pylf_v1_us_DIALTOKEN") => ({ token, base: BASE })
const run = <A>(effect: Effect.Effect<A>) => HeraTest.runTest(effect, HeraTest.layer())

describe("HeraConfig.dials", () => {
  // admits: boundary-io: a merge that drops a default the variable leaves out, or reads the wrong URL
  it("a key the variable sets replaces its default; a key it leaves out keeps it", async () => {
    const { calls, readers } = logfire(serves({ batch: 50, limit: { capacity: 10, refillPerSecond: 1 } }))
    const reading = await run(GROUP.read(readers.reader(key())))
    expect(reading).toEqual({
      values: { batch: 50, retry_ms: 60_000, limit: { capacity: 10, refillPerSecond: 1 } },
      source: "variable",
    })
    expect(calls).toEqual([`${BASE}/v1/variables/dials_test/`])
  })

  // admits: boundary-io: a Logfire failure that throws or leaks a half-applied value instead of every default
  it.each<[string, Answer, string]>([
    ["a transport error", () => Promise.reject(new TypeError("fetch failed")), "unreachable"],
    ["HTTP 530", status(530), "rejected"],
    ["HTTP 401", status(401), "rejected"],
    ["HTTP 404", status(404), "absent"],
    ["a body that is not JSON", status(200, "<html>"), "unparseable"],
    ["a value out of bounds", serves({ batch: 0, retry_ms: 5 }), "invalid"],
    ["a value of the wrong type", serves({ retry_ms: "soon" }), "invalid"],
  ])("%s answers every default with its reason", async (_label, answer, reason) => {
    const { readers } = logfire(answer)
    expect(await run(GROUP.read(readers.reader(key())))).toEqual({ values: DEFAULTS, source: reason })
  })

  // admits: boundary-io: a read key sent to a default host when its base is unset
  it.each<[string, HeraDialReaderKey]>([
    ["no token", { token: undefined, base: BASE }],
    ["a token with no base", { token: "pylf_no_base", base: undefined }],
    ["a token with a blank base", { token: "pylf_blank_base", base: "  " }],
  ])("%s answers unconfigured and never fetches", async (_label, k) => {
    const { calls, readers } = logfire(serves({ batch: 50 }))
    expect(await run(GROUP.read(readers.reader(k)))).toEqual({ values: DEFAULTS, source: "unconfigured" })
    expect(calls).toEqual([])
  })

  // admits: integration: an uncached read per request, or a memo that splits one (base, token) across readers
  it("reads each variable once per TTL, shared by every reader of one key", async () => {
    const { calls, readers } = logfire(serves({ batch: 7 }))
    const got = await run(
      Effect.gen(function* () {
        const a = yield* GROUP.read(readers.reader(key()))
        const b = yield* GROUP.read(readers.reader({ token: " pylf_v1_us_DIALTOKEN ", base: BASE }))
        yield* OTHER.read(readers.reader(key()))
        yield* HeraTest.advanceClock("61 seconds")
        const c = yield* GROUP.read(readers.reader(key()))
        return [a.values.batch, b.values.batch, c.values.batch]
      })
    )
    expect(got).toEqual([7, 7, 7])
    expect(readers.reader(key())).toBe(readers.reader(key()))
    expect(calls).toEqual([
      `${BASE}/v1/variables/dials_test/`,
      `${BASE}/v1/variables/dials_other/`,
      `${BASE}/v1/variables/dials_test/`,
    ])
  })

  // admits: integration: two read keys sharing a reader, so one project's values reach another Worker
  it("a different token has its own reader", async () => {
    const { calls, readers } = logfire(serves({ batch: 9 }))
    await run(GROUP.read(readers.reader(key("pylf_a"))))
    await run(GROUP.read(readers.reader(key("pylf_b"))))
    expect(readers.reader(key("pylf_a"))).not.toBe(readers.reader(key("pylf_b")))
    expect(calls).toHaveLength(2)
  })

  // admits: boundary-io: a hung Logfire stalling a request past the group timeout, whatever the reader's own timeout
  it("a hung Logfire answers every default at the group timeout", async () => {
    const { readers } = logfire(hangs, 30_000)
    const reading = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(GROUP.read(readers.reader(key())))
        yield* Effect.yieldNow
        yield* HeraTest.advanceClock(`${HERA_DIALS_DEFAULT_TIMEOUT_MS + 1} millis`)
        return yield* Fiber.join(fiber)
      })
    )
    expect(reading).toEqual({ values: DEFAULTS, source: "unreachable" })
  })
})
