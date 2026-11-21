import * as Effect from "effect/Effect"
import { Redacted } from "effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { HeraConfig } from "../src/index"
import { HeraTest } from "../src/testing/index"

const TOKEN = "pylf_v1_us_TESTTOKENSECRET"
const Limit = Schema.Struct({ capacity: Schema.Number, refillPerSecond: Schema.Number })
const FALLBACK = { capacity: 10, refillPerSecond: 1 }

type Answer = { readonly status: number; readonly body: string } | Error

/** A fetch that answers from `answers` by path and records every call. */
function fakeFetch(answers: Record<string, Answer>) {
  const calls: { url: string; authorization: string | null }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, authorization: [...new Headers(init?.headers)].find(([k]) => k === "authorization")?.[1] ?? null })
    const answer = answers[new URL(url).pathname]
    if (answer === undefined) return new Response("{}", { status: 404 })
    if (answer instanceof Error) throw answer
    return new Response(answer.body, { status: answer.status })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const entry = (fields: Record<string, unknown>) => ({ status: 200, body: JSON.stringify({ name: "x", ...fields }) })
const latest = (value: unknown) => entry({ latest_version: { version: 1, serialized_value: JSON.stringify(value) } })

const reader = (answers: Record<string, Answer>, token: string | null = TOKEN) => {
  const fake = fakeFetch(answers)
  return {
    ...fake,
    vars: HeraConfig.managedVariables({
      token: token === null ? undefined : Redacted.make(token),
      fetch: fake.fetch,
      ttlMs: 60_000,
    }),
  }
}

const run = <A>(effect: Effect.Effect<A>) => HeraTest.runTest(effect, HeraTest.layer())

describe("HeraConfig.managedVariables", () => {
  // admits: the reader decoding a variable but returning the fallback, or skipping the schema; runtime
  it("answers the variable's latest value decoded through the schema", async () => {
    const { vars, calls } = reader({ "/v1/variables/limits/": latest({ capacity: 5, refillPerSecond: 2 }) })
    const got = await run(vars.get("limits", Limit, FALLBACK))
    expect(got).toEqual({ value: { capacity: 5, refillPerSecond: 2 }, source: "variable" })
    expect(calls).toEqual([
      { url: "https://logfire-us.pydantic.dev/v1/variables/limits/", authorization: `Bearer ${TOKEN}` },
    ])
  })

  // admits: a reason outside the closed set, or a failure that escapes as an error; runtime branches
  it.each<[string, Answer | undefined, string | null, string]>([
    ["no token", latest(FALLBACK), null, "unconfigured"],
    ["a transport failure", new TypeError("network down"), TOKEN, "unreachable"],
    ["a 401", { status: 401, body: '{"detail":"BODY-MARKER"}' }, TOKEN, "rejected"],
    ["a 429", { status: 429, body: "slow down" }, TOKEN, "rejected"],
    ["a 404", undefined, TOKEN, "absent"],
    ["a body that is not JSON", { status: 200, body: "<html>" }, TOKEN, "unparseable"],
    ["a serialized value that is not JSON", entry({ latest_version: { serialized_value: "{oops" } }), TOKEN, "unparseable"],
    ["an entry with no value", entry({}), TOKEN, "absent"],
    ["a value the schema refuses", latest({ capacity: "lots" }), TOKEN, "invalid"],
  ])("%s answers the fallback with reason", async (_label, answer, token, reason) => {
    const { vars } = reader(answer === undefined ? {} : { "/v1/variables/limits/": answer }, token)
    const got = await run(vars.get("limits", Limit, FALLBACK))
    expect(got).toEqual({ value: FALLBACK, source: "fallback", reason })
    expect(JSON.stringify(got)).not.toContain(TOKEN)
    expect(JSON.stringify(got)).not.toContain("BODY-MARKER")
  })

  // admits: the rollout's label ignored, or latest_weight misread; runtime resolution over wire data
  it.each<[string, Record<string, unknown>, number]>([
    ["a label carrying all the weight wins", { rollout: { labels: { prod: 1 }, latest_weight: 0 } }, 7],
    ["latest_weight above every label keeps latest", { rollout: { labels: { prod: 0.2 }, latest_weight: 0.8 } }, 1],
    ["a tie goes to latest", { rollout: { labels: { prod: 0.5 }, latest_weight: 0.5 } }, 1],
    ["no rollout reads latest", {}, 1],
    ["an absent latest_weight yields to a weighted label", { rollout: { labels: { prod: 1 } } }, 7],
    ["a winning label with no value reads latest", { rollout: { labels: { gone: 1 }, latest_weight: 0 } }, 1],
  ])("%s", async (_label, fields, capacity) => {
    const answer = entry({
      latest_version: { serialized_value: JSON.stringify({ capacity: 1, refillPerSecond: 1 }) },
      labels: { prod: { version: 2, serialized_value: JSON.stringify({ capacity: 7, refillPerSecond: 1 }) } },
      ...fields,
    })
    const { vars } = reader({ "/v1/variables/limits/": answer })
    const got = await run(vars.get("limits", Limit, FALLBACK))
    expect(got).toEqual({ value: { capacity, refillPerSecond: 1 }, source: "variable" })
  })

  // admits: a fetch per request, or a cache that never expires; Clock-timed runtime behaviour
  it("reads each name once per TTL, failures included, and again after it", async () => {
    const { vars, calls } = reader({
      "/v1/variables/a/": latest(FALLBACK),
      "/v1/variables/b/": { status: 500, body: "" },
    })
    const counts = await run(
      Effect.gen(function* () {
        yield* vars.get("a", Limit, FALLBACK)
        yield* vars.get("a", Limit, FALLBACK)
        yield* vars.get("b", Limit, FALLBACK)
        yield* vars.get("b", Limit, FALLBACK)
        const within = calls.length
        yield* HeraTest.advanceClock("61 seconds")
        yield* vars.get("a", Limit, FALLBACK)
        return [within, calls.length] as const
      })
    )
    expect(counts).toEqual([2, 3])
  })

  // admits: a name that escapes its path segment; runtime URL building
  it("encodes the name as one path segment under a custom base", async () => {
    const fake = fakeFetch({})
    const vars = HeraConfig.managedVariables({ token: Redacted.make(TOKEN), base: "https://lf.test/", fetch: fake.fetch })
    await run(vars.get("a/b c", Limit, FALLBACK))
    expect(fake.calls[0]?.url).toBe("https://lf.test/v1/variables/a%2Fb%20c/")
  })
})
