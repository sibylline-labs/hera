import { Redacted } from "effect"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { HeraFlags, type LogEntry } from "../src/index"
import { HeraTest } from "../src/testing/index"
import { EMPTY_PROJECT, FLAG_NOT_FOUND_ENTRY, ORG_A, ORG_B, PROBE_FLAG, targeted } from "./fixtures/ofrep"

const TOKEN = "pylf_v1_us_TESTTOKENSECRET"
const BASE = "https://lf.test"

type Answer = { readonly status: number; readonly body?: string; readonly etag?: string } | Error

interface Call {
  readonly url: string
  readonly authorization: string | null
  readonly ifNoneMatch: string | null
  readonly body: Record<string, unknown>
}

/** A fetch that answers from `answer(body.context)` and records every call. */
function fakeFetch(answer: (context: Record<string, unknown>, ifNoneMatch: string | null) => Answer) {
  const calls: Call[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    const call = { url: String(input), authorization: [...headers].find(([k]) => k === "authorization")?.[1] ?? null, ifNoneMatch: headers.get("if-none-match"), body }
    calls.push(call)
    const a = answer(body.context as Record<string, unknown>, call.ifNoneMatch)
    if (a instanceof Error) throw a
    return new Response(a.body ?? null, { status: a.status, headers: a.etag === undefined ? {} : { etag: a.etag } })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

/** The recorded per-context Logfire behaviour: each org's own ETag revalidates to 304. */
const logfire = (context: Record<string, unknown>, ifNoneMatch: string | null): Answer => {
  const answer = targeted(String(context.org_id))
  return ifNoneMatch === answer.etag ? { status: 304 } : { status: 200, ...answer }
}

const reader = (answer: Parameters<typeof fakeFetch>[0], token: string | null = TOKEN) => {
  const fake = fakeFetch(answer)
  return {
    ...fake,
    flags: HeraFlags.ofrep({ token: token === null ? undefined : Redacted.make(token), base: `${BASE}/`, fetch: fake.fetch }),
  }
}

/** Runs `effect` with a log sink and returns its value and every warn line. */
async function runLogged<A>(effect: Effect.Effect<A>) {
  const lines: LogEntry[] = []
  const value = await HeraTest.runTest(effect, HeraTest.layer({ sink: (_line, entry) => lines.push(entry) }))
  return { value, warns: lines.filter((l) => l.level === "warn"), lines }
}

const orgA = { targetingKey: ORG_A }
const orgB = { targetingKey: ORG_B }

describe("HeraFlags.ofrep", () => {
  // admits: the org's override ignored, or one org's answer served to another; runtime targeting
  it("answers the targeted value for a matching org and the default for another", async () => {
    const { flags, calls } = reader(logfire)
    const { value, warns } = await runLogged(
      Effect.all([flags.bool(PROBE_FLAG, orgA, false), flags.bool(PROBE_FLAG, orgB, true)])
    )
    expect(value).toEqual([true, false])
    expect(warns).toEqual([])
    expect(calls.map((c) => [c.url, c.authorization])).toEqual([
      [`${BASE}/v1/ofrep/v1/evaluate/flags`, `Bearer ${TOKEN}`],
      [`${BASE}/v1/ofrep/v1/evaluate/flags`, `Bearer ${TOKEN}`],
    ])
  })

  // admits: the org sent only as the targeting key (Logfire matches attributes), or a caller's own org_id overwritten
  it("sends the org as targetingKey and as the org_id attribute, keeping an explicit org_id", async () => {
    const { flags, calls } = reader(logfire)
    await runLogged(
      Effect.all([
        flags.bool(PROBE_FLAG, { targetingKey: ORG_A, attributes: { plan: "pro" } }, false),
        flags.bool(PROBE_FLAG, { targetingKey: "user-1", attributes: { org_id: ORG_B } }, false),
      ])
    )
    expect(calls.map((c) => c.body)).toEqual([
      { context: { org_id: ORG_A, plan: "pro", targetingKey: ORG_A } },
      { context: { org_id: ORG_B, targetingKey: "user-1" } },
    ])
  })

  // admits: a failure that escapes, a reason outside the closed set, or a token/body in the answer or log; runtime branches
  it.each<[string, Answer, string | null, string]>([
    ["no token", { status: 200, ...EMPTY_PROJECT }, null, "unconfigured"],
    ["an unreachable endpoint", new TypeError("network down"), TOKEN, "unreachable"],
    ["a 401", { status: 401, body: '{"errorDetails":"BODY-MARKER"}' }, TOKEN, "rejected"],
    ["a 429", { status: 429, body: "slow down BODY-MARKER" }, TOKEN, "rejected"],
    ["a 500", { status: 500, body: "BODY-MARKER" }, TOKEN, "rejected"],
    ["a body that is not JSON", { status: 200, body: "<html>BODY-MARKER" }, TOKEN, "unparseable"],
    ["a body that is not OFREP", { status: 200, body: '{"flagz":"BODY-MARKER"}' }, TOKEN, "unparseable"],
    ["a project without the flag (recorded)", { status: 200, ...EMPTY_PROJECT }, TOKEN, "absent"],
    ["a FLAG_NOT_FOUND entry", { status: 200, body: JSON.stringify({ flags: [FLAG_NOT_FOUND_ENTRY] }) }, TOKEN, "absent"],
    ["a null value", { status: 200, body: JSON.stringify({ flags: [{ key: PROBE_FLAG, value: null, reason: "DEFAULT" }] }) }, TOKEN, "absent"],
    ["another error code", { status: 200, body: JSON.stringify({ flags: [{ key: PROBE_FLAG, errorCode: "TYPE_MISMATCH", errorDetails: "BODY-MARKER" }] }) }, TOKEN, "errored"],
    ["a value bool refuses", { status: 200, body: JSON.stringify({ flags: [{ key: PROBE_FLAG, value: "yes" }] }) }, TOKEN, "invalid"],
  ])("%s answers the fallback with one warn line and reason", async (_label, answer, token, reason) => {
    const { flags } = reader(() => answer, token)
    const { value, warns, lines } = await runLogged(
      Effect.all([
        flags.evaluate(PROBE_FLAG, Schema.Boolean, orgA, false),
        flags.bool(PROBE_FLAG, orgA, false),
        flags.bool(PROBE_FLAG, orgA, false),
      ])
    )
    expect(value).toEqual([{ value: false, source: "fallback", reason }, false, false])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ msg: HeraFlags.FALLBACK_EVENT, flag: PROBE_FLAG, reason })
    const everything = JSON.stringify([value, lines])
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain("BODY-MARKER")
    expect(everything).not.toContain(ORG_A)
  })

  // admits: a fetch per request, a cache that never expires, or an outage warned per request; Clock-timed
  it("reads each context once per TTL, failures included, and warns once per window", async () => {
    const { flags, calls } = reader(() => new TypeError("down"))
    const { value, warns } = await runLogged(
      Effect.gen(function* () {
        yield* flags.bool(PROBE_FLAG, orgA, false)
        yield* flags.bool(PROBE_FLAG, orgA, false)
        yield* flags.bool("other", orgA, false)
        const within = calls.length
        yield* HeraTest.advanceClock("61 seconds")
        yield* flags.bool(PROBE_FLAG, orgA, false)
        return [within, calls.length] as const
      })
    )
    expect(value).toEqual([1, 2])
    expect(warns).toHaveLength(2)
  })

  // admits: no revalidation, an ETag sent to the wrong context, or a 304 read as a failure; wire behaviour
  it("revalidates with the context's own ETag and reuses its flags on a 304", async () => {
    const { flags, calls } = reader(logfire)
    const { value, warns } = await runLogged(
      Effect.gen(function* () {
        yield* flags.bool(PROBE_FLAG, orgA, false)
        yield* flags.bool(PROBE_FLAG, orgB, true)
        yield* HeraTest.advanceClock("61 seconds")
        return [yield* flags.bool(PROBE_FLAG, orgA, false), yield* flags.bool(PROBE_FLAG, orgB, true)] as const
      })
    )
    expect(value).toEqual([true, false])
    expect(warns).toEqual([])
    expect(calls.map((c) => c.ifNoneMatch)).toEqual([null, null, targeted(ORG_A).etag, targeted(ORG_B).etag])
  })

  // admits: a schema skipped, or a decoded value replaced by the fallback; runtime decode
  it("decodes a structured value through the caller's schema", async () => {
    const Limit = Schema.Struct({ rpm: Schema.Number })
    const { flags } = reader(() => ({ status: 200, body: JSON.stringify({ flags: [{ key: "limit", value: { rpm: 5 }, variant: "pro" }] }) }))
    const { value } = await runLogged(flags.evaluate("limit", Limit, orgA, { rpm: 1 }))
    expect(value).toEqual({ value: { rpm: 5 }, source: "flag", variant: "pro" })
  })
})

describe("HeraTest.flags", () => {
  // admits: a double that skips the production fallback path, or serves one org's value to another
  it("targets per org, falls back and warns like the OFREP reader, and toggles an outage", async () => {
    const flags = HeraTest.flags({ "inference-enabled": { value: false, orgs: { [ORG_A]: true } } })
    const first = await runLogged(
      Effect.all([
        flags.bool("inference-enabled", orgA, false),
        flags.bool("inference-enabled", orgB, true),
        flags.bool("missing", orgA, true),
        flags.bool("missing", orgA, true),
      ])
    )
    expect(first.value).toEqual([true, false, true, true])
    expect(first.warns.map((w) => w.reason)).toEqual(["absent"])

    flags.setUnreachable(true)
    const down = await runLogged(flags.evaluate("inference-enabled", Schema.Boolean, orgA, false))
    expect(down.value).toEqual({ value: false, source: "fallback", reason: "unreachable" })
    expect(down.warns).toHaveLength(1)

    flags.setUnreachable(false)
    flags.set("inference-enabled", { value: true })
    expect((await runLogged(flags.bool("inference-enabled", orgB, false))).value).toBe(true)
  })
})
