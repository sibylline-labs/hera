import { describe, expect, it } from "vitest"
import { HeraWebhook } from "../src/index"
import { NOW_S, admitted, hmacHex, post, refusedWith } from "./webhook-helpers"

const SECRET = "whsec_current_8f2e1d"
const PREVIOUS = "whsec_previous_3a9c4b"
const BODY = '{"id":"evt_1","object":"event","type":"invoice.paid"}'

const verifier = (secret: string | ReadonlyArray<string> = SECRET) => HeraWebhook.stripe({ secret })

// Computed the way Stripe's libraries sign: HMAC-SHA256 of `${t}.${body}`, hex.
async function header(t: number | string, key: string = SECRET, body: string = BODY): Promise<string> {
  return `t=${t},v1=${await hmacHex(key, `${t}.${body}`)}`
}

const deliver = (value: string, body: string = BODY) => post(body, { "stripe-signature": value })

describe("HeraWebhook.stripe — admits", () => {
  // admits: a delivery signed the way Stripe's libraries sign it refused; the HMAC is runtime.
  it("verifies a body signed as `${t}.${body}` under a whsec_ string", async () => {
    expect(await admitted(verifier(), deliver(await header(NOW_S - 10)))).toBe(BODY)
  })

  // admits: rotation breaking when Stripe sends one v1 per active secret; which secret signed is runtime.
  it("verifies a rotation header with two v1s under either secret alone", async () => {
    const t = NOW_S
    const value = `t=${t},v1=${await hmacHex(PREVIOUS, `${t}.${BODY}`)},v1=${await hmacHex(SECRET, `${t}.${BODY}`)}`
    expect(await admitted(verifier(SECRET), deliver(value))).toBe(BODY)
    expect(await admitted(verifier(PREVIOUS), deliver(value))).toBe(BODY)
  })

  // admits: another scheme (v0) turning a refusal into an admit, or breaking an otherwise valid header.
  it("ignores other schemes", async () => {
    const value = `${await header(NOW_S)},v0=${"0".repeat(64)}`
    expect(await admitted(verifier(), deliver(value))).toBe(BODY)
  })
})

describe("HeraWebhook.stripe — refuses", () => {
  // admits: a forged delivery; HMAC over bytes is runtime.
  it("a tampered body, a wrong secret or a rewritten t is bad_signature", async () => {
    const good = await header(NOW_S)
    expect(await refusedWith(verifier(), deliver(good, `${BODY} `))).toBe("bad_signature")
    expect(await refusedWith(verifier("whsec_other"), deliver(good))).toBe("bad_signature")
    const rewritten = good.replace(`t=${NOW_S}`, `t=${NOW_S + 1}`)
    expect(await refusedWith(verifier(), deliver(rewritten))).toBe("bad_signature")
  })

  // admits: a captured delivery replayed, or a future-dated one admitted; tolerance arithmetic is runtime.
  it("t outside the 300 s tolerance in either direction is stale", async () => {
    expect(await refusedWith(verifier(), deliver(await header(NOW_S - 301)))).toBe("stale")
    expect(await refusedWith(verifier(), deliver(await header(NOW_S + 301)))).toBe("stale")
    expect(await admitted(verifier(), deliver(await header(NOW_S - 299)))).toBe(BODY)
  })

  // admits: a header with no usable t verifying over a guessed timestamp.
  it("t missing or repeated is missing_timestamp", async () => {
    const v1 = await hmacHex(SECRET, `${NOW_S}.${BODY}`)
    expect(await refusedWith(verifier(), deliver(`v1=${v1}`))).toBe("missing_timestamp")
    expect(await refusedWith(verifier(), deliver(`t=${NOW_S},t=${NOW_S},v1=${v1}`))).toBe("missing_timestamp")
  })

  // admits: a non-decimal t reading as fresh; NaN compares false both ways.
  it("a non-decimal t is never within tolerance", async () => {
    const t = "1e9"
    expect(await refusedWith(verifier(), deliver(await header(t)))).toBe("stale")
  })

  // admits: a header with no v1, or only undecodable ones, reaching a key import.
  it("no v1, or only an undecodable v1, is malformed_signature", async () => {
    expect(await refusedWith(verifier(), deliver(`t=${NOW_S}`))).toBe("malformed_signature")
    expect(await refusedWith(verifier(), deliver(`t=${NOW_S},v0=${"a".repeat(64)}`))).toBe("malformed_signature")
    expect(await refusedWith(verifier(), deliver(`t=${NOW_S},v1=zz`))).toBe("malformed_signature")
    expect(await refusedWith(verifier(), post(BODY, {}))).toBe("missing_signature")
  })

  // admits: an unset secret admitting every delivery.
  it("an empty secret is unconfigured", async () => {
    expect(await refusedWith(verifier(""), deliver(await header(NOW_S)))).toBe("unconfigured")
  })
})
