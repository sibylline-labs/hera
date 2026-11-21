import { afterEach, describe, expect, it, vi } from "vitest"
import { HeraWebhook, type HeraWebhookOptions } from "../src/index"
import { NOW_S, admitted, hmacHex, post, refusedWith } from "./webhook-helpers"

const SECRET = "whsec_current_8f2e1d"
const BODY = '{"ok":true}'

// A provider sending `<ts>|<hex>|<hex>…` in one header.
const parse: NonNullable<HeraWebhookOptions["parse"]> = (value) => {
  const [timestamp, ...signatures] = value.split("|")
  return timestamp === undefined ? undefined : { timestamp, signatures }
}
const payload = (timestamp: string, body: Uint8Array<ArrayBuffer>) =>
  new Uint8Array([...new TextEncoder().encode(`${timestamp}:`), ...body])

const options = (over: Partial<HeraWebhookOptions> = {}): HeraWebhookOptions => ({
  secret: SECRET,
  header: "x-sig",
  parse,
  timestamp: { signed: true, payload, unit: "s", toleranceMs: 60_000 },
  ...over,
})
const verify = (over?: Partial<HeraWebhookOptions>) => HeraWebhook.verifyHmac(options(over))
const sig = (t: number | string, key = SECRET) => hmacHex(key, `${t}:${BODY}`)
const send = (value: string) => post(BODY, { "x-sig": value })

afterEach(() => {
  vi.restoreAllMocks()
})

describe("verifyHmac parse + signed timestamp", () => {
  // admits: the parsed timestamp not covered by the HMAC (replayable), or a valid combined header refused.
  it("verifies over payload(timestamp, body) with the parsed timestamp", async () => {
    expect(await admitted(verify(), send(`${NOW_S}|${await sig(NOW_S)}`))).toBe(BODY)
  })

  // admits: only the first candidate checked, or the last; which candidate matches is runtime.
  it("admits when any candidate matches, undecodable ones dropped", async () => {
    const value = `${NOW_S}|zz|${await sig(NOW_S, "other")}|${await sig(NOW_S)}`
    expect(await admitted(verify(), send(value))).toBe(BODY)
  })

  // admits: an early exit (timing leak of which key/candidate matched); call counts are runtime.
  it("verifies every key x every candidate with crypto.subtle.verify, no early exit", async () => {
    const spy = vi.spyOn(crypto.subtle, "verify")
    const value = `${NOW_S}|${await sig(NOW_S)}|${await sig(NOW_S, "x")}|${await sig(NOW_S, "y")}`
    await admitted(verify({ secret: [SECRET, "second"] }), send(value))
    expect(spy).toHaveBeenCalledTimes(6)
  })

  // admits: a shape failure reaching key import (cost order); import calls are runtime.
  it("refuses a bad shape before importing any key", async () => {
    const spy = vi.spyOn(crypto.subtle, "importKey")
    const nine = Array.from({ length: 9 }, () => "a".repeat(64)).join("|")
    expect(await refusedWith(verify(), send(`${NOW_S}|${nine}`))).toBe("malformed_signature")
    expect(await refusedWith(verify(), send(`${NOW_S}|zz`))).toBe("malformed_signature")
    expect(await refusedWith(verify({ parse: () => undefined }), send("x"))).toBe("malformed_signature")
    expect(await refusedWith(verify({ parse: () => ({ signatures: [] }) }), send("x"))).toBe("malformed_signature")
    expect(
      await refusedWith(verify({ parse: () => { throw new Error("boom") } }), send("x")),
    ).toBe("malformed_signature")
    expect(spy).not.toHaveBeenCalled()
  })

  // admits: exactly 8 candidates refused, or a ninth admitted.
  it("allows eight candidates", async () => {
    const eight = [await sig(NOW_S), ...Array.from({ length: 7 }, () => "a".repeat(64))].join("|")
    expect(await admitted(verify(), send(`${NOW_S}|${eight}`))).toBe(BODY)
  })

  // admits: a missing or non-decimal parsed timestamp verifying or reading as fresh.
  it("refuses a missing parsed timestamp and a non-decimal or stale one", async () => {
    const withoutTs = verify({ parse: (v) => ({ signatures: v.split("|") }) })
    expect(await refusedWith(withoutTs, send(await sig(NOW_S)))).toBe("missing_timestamp")
    expect(await refusedWith(verify(), send(`1e9|${await sig("1e9")}`))).toBe("stale")
    expect(await refusedWith(verify(), send(`${NOW_S - 61}|${await sig(NOW_S - 61)}`))).toBe("stale")
    expect(await refusedWith(verify(), send(`${NOW_S + 61}|${await sig(NOW_S + 61)}`))).toBe("stale")
  })

  // admits: a rewritten timestamp admitted because the HMAC did not cover it.
  it("a rewritten timestamp is bad_signature", async () => {
    expect(await refusedWith(verify(), send(`${NOW_S + 1}|${await sig(NOW_S)}`))).toBe("bad_signature")
  })

  // admits: a throwing payload builder surfacing as a 500 or an admit.
  it("a throwing payload is bad_signature", async () => {
    const throwing = verify({ timestamp: { signed: true, payload: () => { throw new Error("x") }, toleranceMs: 1000 } })
    expect(await refusedWith(throwing, send(`${NOW_S}|${await sig(NOW_S)}`))).toBe("bad_signature")
  })

  // admits: a signed arm built without parse, silently verifying nothing useful.
  it("throws at construction for signed without parse", () => {
    expect(() => HeraWebhook.verifyHmac(options({ parse: undefined }))).toThrow(/parse/)
  })
})
