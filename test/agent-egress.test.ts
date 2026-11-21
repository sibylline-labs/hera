import type { Api, Model, ProviderStreams, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import { deniedEgressHost } from "../src/server/agent/egress/allowlist.js"
import { HeraAgentEgress } from "../src/server/agent/egress/egress.js"
import { HeraAgentMeter } from "../src/server/agent/egress/meter.js"
import { meteredStreams } from "../src/server/agent/egress/metered-streams.js"
import { catalogModel, HeraAgentModels } from "../src/server/agent/models/catalog.js"
import { HeraAgentTest } from "../src/testing/agent/index.js"

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta"
const route = { baseUrl: GATEWAY, headers: {} }
const gemma = catalogModel("gemma-4-26b-a4b-it", route)
const argon = catalogModel("gemini-4-argon", route)
const context: TranscriptContext = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] })

/** Records each request the upstream received; answers from `inner`. */
function recording(inner: ProviderStreams) {
  const seen: Array<{ model: string; reasoning: unknown; headers: Record<string, string> | undefined }> = []
  const upstream: ProviderStreams = {
    stream: (m, c, o) => {
      seen.push({ model: m.id, reasoning: undefined, headers: m.headers })
      return inner.stream(m, c, o)
    },
    streamSimple: (m, c, o?: SimpleStreamOptions) => {
      seen.push({ model: m.id, reasoning: o?.reasoning, headers: m.headers })
      return inner.streamSimple(m, c, o)
    },
  }
  return { upstream, seen }
}

function wrap(inner: ProviderStreams, fallback: Model<Api> | undefined = argon) {
  const meter = HeraAgentMeter.memory()
  const streams = meteredStreams(inner, {
    meter,
    selection: [HeraAgentModels.default, HeraAgentModels.fallback],
    fallback,
    now: () => 1,
  })
  return { meter, streams }
}

describe("HeraAgentEgress allowlist", () => {
  // admits: a model routed off the gateway (a direct Google URL, a lookalike host, http) must not leave.
  it("refuses a host outside the allowlist before any request, ending the stream in error", async () => {
    const { upstream, seen } = recording(HeraAgentTest.script([HeraAgentTest.text("x")]))
    const { meter, streams } = wrap(upstream)
    for (const baseUrl of [
      "https://generativelanguage.googleapis.com/v1beta",
      "https://gateway.ai.cloudflare.com.evil.test/v1",
      "http://gateway.ai.cloudflare.com/v1",
      "https://gateway.ai.cloudflare.com:8443/v1",
    ]) {
      const result = await streams.streamSimple({ ...gemma, baseUrl }, context).result()
      expect(result.stopReason, baseUrl).toBe("error")
      expect(result.errorMessage, baseUrl).toMatch(/^agent_egress_host_denied: /)
    }
    expect(seen).toEqual([])
    expect(meter.rows()).toEqual([])
    expect(deniedEgressHost(GATEWAY)).toBeUndefined()
  })
})

describe("HeraAgentEgress meter", () => {
  // admits: billing drift: every model request must leave exactly one usage row, from its final usageMetadata.
  it("writes one row per request from the last usage chunk, keyed by cf-aig-log-id", async () => {
    const { meter, streams } = wrap(
      HeraAgentTest.script([
        HeraAgentTest.toolCall("lookup", { key: "a" }, { logId: "log-1", usage: { promptTokens: 12, candidatesTokens: 3, thoughtsTokens: 7 } }),
      ])
    )
    await streams.streamSimple(gemma, context).result()
    expect(meter.rows()).toEqual([
      { logId: "log-1", atMs: 1, model: "gemma-4-26b-a4b-it", inputTokens: 12, candidatesTokens: 3, thoughtsTokens: 7, cachedTokens: 0, totalTokens: 22 },
    ])
  })

  // admits: double billing: a replayed response (same gateway log id) must not write a second row; two requests write two.
  it("writes nothing for a replayed request and one row each for distinct requests", async () => {
    const replayed = wrap(HeraAgentTest.script([HeraAgentTest.text("same", { logId: "log-r" })]))
    await replayed.streams.streamSimple(gemma, context).result()
    await replayed.streams.streamSimple(gemma, context).result()
    expect(replayed.meter.rows().map((r) => r.logId)).toEqual(["log-r"])

    const distinct = wrap(HeraAgentTest.script([HeraAgentTest.text("fresh")]))
    await distinct.streams.streamSimple(gemma, context).result()
    await distinct.streams.streamSimple(gemma, context).result()
    expect(distinct.meter.rows()).toHaveLength(2)
  })

  // admits: a request that reports usage but carries no gateway log id or response id being silently unmetered.
  it("meters a request with usage but no key under a fresh key", async () => {
    const keyless: ProviderStreams = {
      stream: (m, c, o) => HeraAgentTest.script([HeraAgentTest.text("x")]).stream(m, c, { ...o, onProviderStreamEvent: (chunk, mm) => o?.onProviderStreamEvent?.({ usageMetadata: (chunk as { usageMetadata: unknown }).usageMetadata }, mm) }),
      streamSimple: (m, c, o) => HeraAgentTest.script([HeraAgentTest.text("x")]).streamSimple(m, c, { ...o, onProviderStreamEvent: (chunk, mm) => o?.onProviderStreamEvent?.({ usageMetadata: (chunk as { usageMetadata: unknown }).usageMetadata }, mm) }),
    }
    const { meter, streams } = wrap(keyless)
    await streams.streamSimple(gemma, context).result()
    expect(meter.rows().map((r) => r.logId)).toEqual([expect.stringMatching(/^unkeyed-/)])
  })

  // admits: a usage-less or failed request inventing a zero row.
  it("writes no row for a request that reported no usage", async () => {
    const { meter, streams } = wrap(HeraAgentTest.script([HeraAgentTest.fail("boom")]), undefined)
    const result = await streams.streamSimple(gemma, context).result()
    expect(result.stopReason).toBe("error")
    expect(meter.rows()).toEqual([])
  })

  // admits: A4: a stream settling after purge recreating the meter table on the emptied store.
  it("stops writing once closed", async () => {
    const { meter, streams } = wrap(HeraAgentTest.script([HeraAgentTest.text("late", { logId: "log-late" })]))
    meter.close()
    await streams.streamSimple(gemma, context).result()
    expect(meter.rows()).toEqual([])
  })
})

describe("HeraAgentEgress models and fallback", () => {
  // admits: the ruled thinking levels drifting: argon must run at low, gemma with thinking off, whatever the session asked.
  it("runs gemini-4-argon at thinking low and gemma with thinking off", async () => {
    const { upstream, seen } = recording(HeraAgentTest.script([HeraAgentTest.text("a")]))
    const { streams } = wrap(upstream)
    await streams.streamSimple(argon, context, { reasoning: "high" }).result()
    await streams.streamSimple(gemma, context, { reasoning: "high" }).result()
    expect(seen.map((s) => [s.model, s.reasoning])).toEqual([
      ["gemini-4-argon", "low"],
      ["gemma-4-26b-a4b-it", undefined],
    ])
  })

  // admits: hydrogen being unselectable, unmetered, or its selection moving the ruled default and fallback.
  it("runs gemini-4-hydrogen when selected, metered at its own model id, leaving default and fallback alone", async () => {
    const hydrogen = catalogModel("gemini-4-hydrogen", route)
    const { upstream, seen } = recording(HeraAgentTest.script([HeraAgentTest.text("h", { logId: "log-h" })]))
    const meter = HeraAgentMeter.memory()
    const streams = meteredStreams(upstream, { meter, selection: [{ id: "gemini-4-hydrogen", thinkingLevel: "high" }], fallback: undefined, now: () => 1 })
    await streams.streamSimple(hydrogen, context).result()
    expect(seen.map((s) => [s.model, s.reasoning])).toEqual([["gemini-4-hydrogen", "high"]])
    expect(meter.rows().map((r) => [r.logId, r.model])).toEqual([["log-h", "gemini-4-hydrogen"]])
    expect(HeraAgentModels.default).toEqual({ id: "gemma-4-26b-a4b-it" })
    expect(HeraAgentModels.fallback).toEqual({ id: "gemini-4-argon", thinkingLevel: "low" })
    expect(HeraAgentModels.ids).not.toContain("gemini-2.5-flash")
  })

  // admits: the fallback firing on a partial answer (double output) or never firing on an empty failure.
  it("re-issues once on the fallback only when the primary fails before any content", async () => {
    const failing: ProviderStreams = {
      stream: (m, c, o) => (m.id === "gemma-4-26b-a4b-it" ? HeraAgentTest.script([HeraAgentTest.fail("503")]) : HeraAgentTest.script([HeraAgentTest.text("from argon", { logId: "log-argon" })])).stream(m, c, o),
      streamSimple: (m, c, o) => (m.id === "gemma-4-26b-a4b-it" ? HeraAgentTest.script([HeraAgentTest.fail("503")]) : HeraAgentTest.script([HeraAgentTest.text("from argon", { logId: "log-argon" })])).streamSimple(m, c, o),
    }
    const { upstream, seen } = recording(failing)
    const { meter, streams } = wrap(upstream)
    const result = await streams.streamSimple(gemma, context).result()
    expect(result.content).toEqual([{ type: "text", text: "from argon" }])
    expect(seen.map((s) => [s.model, s.reasoning])).toEqual([
      ["gemma-4-26b-a4b-it", undefined],
      ["gemini-4-argon", "low"],
    ])
    expect(meter.rows().map((r) => [r.logId, r.model])).toEqual([["log-argon", "gemini-4-argon"]])

    const answered = wrap(HeraAgentTest.script([HeraAgentTest.text("primary")]))
    expect((await answered.streams.streamSimple(gemma, context).result()).content).toEqual([{ type: "text", text: "primary" }])
  })

  // admits: the fallback re-issuing the primary's tool-call history unsigned, which gemini-4-argon refuses with
  // `400 Function call is missing a thought_signature` (observed Nov-11), so the fallback never answers a tool-using run.
  it("signs every unsigned functionCall part of the fallback request and leaves the primary request as built", async () => {
    const built = () => ({
      model: "m",
      contents: [
        { role: "user", parts: [{ text: "resolve" }] },
        {
          role: "model",
          parts: [
            { functionCall: { name: "resolve_apply", args: { childId: "a" } }, thoughtSignature: "c2ln" },
            { functionCall: { name: "resolve_apply", args: { childId: "b" } } },
          ],
        },
        { role: "user", parts: [{ functionResponse: { name: "resolve_apply", response: { ok: true } } }] },
        { role: "model", parts: [{ functionCall: { name: "resolve_settle", args: { childId: "c" } } }] },
      ],
    })
    const requests: Array<{ model: Model<Api>; onPayload: SimpleStreamOptions["onPayload"] }> = []
    const answer = (m: Model<Api>) =>
      HeraAgentTest.script([m.id === "gemma-4-26b-a4b-it" ? HeraAgentTest.fail("400") : HeraAgentTest.text("from argon")])
    const upstream: ProviderStreams = {
      stream: (m, c, o) => answer(m).stream(m, c, o),
      streamSimple: (m, c, o) => {
        requests.push({ model: m, onPayload: o?.onPayload })
        return answer(m).streamSimple(m, c, o)
      },
    }
    const { streams } = wrap(upstream)
    const result = await streams.streamSimple(gemma, context).result()
    expect(result.content).toEqual([{ type: "text", text: "from argon" }])

    const signatures = async (r: (typeof requests)[number]) => {
      const payload = ((await r.onPayload?.(built(), r.model)) ?? built()) as ReturnType<typeof built>
      return payload.contents.flatMap((c) =>
        c.parts.flatMap((part) => ("functionCall" in part ? [(part as { thoughtSignature?: string }).thoughtSignature ?? null] : []))
      )
    }
    expect(requests.map((r) => r.model.id)).toEqual(["gemma-4-26b-a4b-it", "gemini-4-argon"])
    expect(await signatures(requests[0]!)).toEqual(["c2ln", null, null])
    expect(await signatures(requests[1]!)).toEqual(["c2ln", "skip_thought_signature_validator", "skip_thought_signature_validator"])
  })
})

describe("HeraAgentEgress.make", () => {
  const base = { accountId: "acct_1", gateway: "polaris-agents", apiKey: Redacted.make("gemini-key") }
  const metadata = { tenant: "org_1", agent: "probe", service: "polaris-agents" }

  async function headersFor(config: Parameters<typeof HeraAgentEgress.make>[0]["config"]) {
    const { upstream, seen } = recording(HeraAgentTest.script([HeraAgentTest.text("ok")]))
    const models = HeraAgentEgress.make({ config, metadata, model: HeraAgentModels.default, meter: HeraAgentMeter.memory(), upstream })
    const model = models.getModel("google", "gemma-4-26b-a4b-it")
    expect(model?.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/acct_1/polaris-agents/google-ai-studio/v1beta")
    await models.streamSimple(model!, context).result()
    return seen[0]?.headers ?? {}
  }

  // admits: Dan, Nov-07: the gateway token is optional; without one no cf-aig-authorization may be sent.
  it("sends cf-aig-authorization only when a gateway token is configured", async () => {
    const without = await headersFor(base)
    expect(without["cf-aig-authorization"]).toBeUndefined()
    expect(JSON.parse(without["cf-aig-metadata"] ?? "{}")).toEqual(metadata)
    const withToken = await headersFor({ ...base, gatewayToken: Redacted.make("aig-token") })
    expect(withToken["cf-aig-authorization"]).toBe("Bearer aig-token")
  })

  // admits: a missing key or a path-injecting account id must refuse, naming the field only.
  it("refuses a missing or malformed config value, naming the field", () => {
    const build = (config: Parameters<typeof HeraAgentEgress.make>[0]["config"]) => () =>
      HeraAgentEgress.make({ config, metadata, model: HeraAgentModels.default, meter: HeraAgentMeter.memory() })
    expect(build({ ...base, apiKey: "  " })).toThrow(expect.objectContaining({ code: "agent_egress_unconfigured", field: "apiKey" }))
    expect(build({ ...base, accountId: "acct/../x" })).toThrow(expect.objectContaining({ field: "accountId" }))
    expect(build({ ...base, gateway: "" })).toThrow(expect.objectContaining({ field: "gateway" }))
  })
})
