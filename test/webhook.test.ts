import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Redacted from "effect/Redacted"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  HeraConfig,
  HeraError,
  HeraWebhook,
  type HeraWebhookOptions,
  type HeraWebhookRefusalReason,
  type Keyring,
} from "../src/index"
import { HeraTest } from "../src/testing/index"

const SECRET = "whsec_current_8f2e1d"
const PREVIOUS = "whsec_previous_3a9c4b"
const BODY = '{"type":"OAuthApp","action":"revoked","webhookTimestamp":1730000000000}'
const NOW_MS = 1_730_000_000_000

const encoder = new TextEncoder()

async function sign(
  key: string | Uint8Array,
  body: string,
  hash: "SHA-256" | "SHA-384" | "SHA-512" = "SHA-256",
  encoding: "hex" | "base64" = "hex",
): Promise<string> {
  const keyBytes = typeof key === "string" ? encoder.encode(key) : key
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash },
    false,
    ["sign"],
  )
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(body)))
  if (encoding === "base64") return btoa(String.fromCharCode(...digest))
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
}

function request(body: string | Uint8Array, headers: Record<string, string>): Request {
  return new Request("https://gateway.test/v1/webhooks/linear", {
    method: "POST",
    headers,
    body: body as BodyInit,
  })
}

type Logged = Array<Record<string, unknown>>

async function run(options: HeraWebhookOptions, req: Request, logged: Logged = []) {
  const layer = HeraTest.layer({
    initialTimeMs: NOW_MS,
    sink: (_line, entry) => {
      logged.push(entry)
    },
  })
  return HeraTest.runTestExit(HeraWebhook.verifyHmac(options)(req), layer)
}

async function refusal(options: HeraWebhookOptions, req: Request, logged?: Logged) {
  const exit = await run(options, req, logged)
  if (!Exit.isFailure(exit)) throw new Error("expected a refusal")
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error
  if (!HeraError.is(error)) throw new Error("expected a HeraError")
  return error
}

async function body(options: HeraWebhookOptions, req: Request): Promise<string> {
  const exit = await run(options, req)
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${String(exit)}`)
  return new TextDecoder().decode(exit.value)
}

const slackPayload = (timestamp: string, raw: Uint8Array): Uint8Array =>
  new Uint8Array([...encoder.encode(`v0:${timestamp}:`), ...raw])

const linear = (secret: HeraWebhookOptions["secret"]): HeraWebhookOptions => ({
  secret,
  header: "linear-signature",
})

const FIXED_401 = {
  type: "urn:hera:error:invalid_signature",
  title: "Invalid request signature",
  status: 401,
  detail: "Invalid request signature",
  code: "invalid_signature",
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("HeraWebhook.verifyHmac — accepts", () => {
  // admits: a valid delivery refused or its body altered; HMAC over bytes is runtime, no type sees it.
  it("returns the raw body for a valid signature under a single secret", async () => {
    const sig = await sign(SECRET, BODY)
    expect(await body(linear(SECRET), request(BODY, { "linear-signature": sig }))).toBe(BODY)
  })

  // admits: rotation breaking: the previous slot stops verifying mid-rollover; which key signed is runtime.
  it("accepts the current or the previous of two slots (string and Redacted)", async () => {
    const secrets = [Redacted.make(SECRET), PREVIOUS] as const
    for (const key of [SECRET, PREVIOUS]) {
      const sig = await sign(key, BODY)
      expect(await body(linear(secrets), request(BODY, { "linear-signature": sig }))).toBe(BODY)
    }
  })

  // admits: a keyring verifying only its current (highest) entry; key choice is runtime.
  it("accepts any key of a keyring, current or previous, plain or Redacted", async () => {
    const status = HeraConfig.keyring({ K: HeraTest.makeTestKeyring([1, 2]) }, "K")
    if (status._tag !== "Valid") throw new Error("keyring fixture invalid")
    const ring: Keyring = Redacted.value(status.value)
    for (const version of ["v1", "v2"]) {
      const sig = await sign(ring.get(version)!, BODY)
      expect(await body(linear(ring), request(BODY, { "linear-signature": sig }))).toBe(BODY)
      expect(await body(linear(status.value), request(BODY, { "linear-signature": sig }))).toBe(BODY)
    }
  })

  // admits: a non-constant-time compare or an early exit that times which key matched; no lint tells a digest compare from any `===`.
  it("verifies every key with crypto.subtle.verify and never early-exits", async () => {
    const verify = vi.spyOn(crypto.subtle, "verify")
    const sig = await sign(SECRET, BODY)
    await body(linear([SECRET, PREVIOUS]), request(BODY, { "linear-signature": sig }))
    expect(verify).toHaveBeenCalledTimes(2)
  })

  // admits: a `wrangler secret put` newline breaking verification, or a second newline silently dropped; string values are runtime.
  it("strips exactly one trailing line ending from a string secret", async () => {
    const sig = await sign(SECRET, BODY)
    const req = () => request(BODY, { "linear-signature": sig })
    expect(await body(linear(`${SECRET}\n`), req())).toBe(BODY)
    expect(await body(linear(`${SECRET}\r\n`), req())).toBe(BODY)
    const twice = await refusal(linear(`${SECRET}\n\n`), req())
    expect(HeraWebhook.refusalReason(twice)).toBe("bad_signature")
  })

  // admits: a provider with a prefixed or base64 header never verifying, or a bare value passing a required prefix; header text is runtime.
  it("supports a prefix, base64 and SHA-512", async () => {
    const sig = await sign(SECRET, BODY, "SHA-512", "base64")
    const options: HeraWebhookOptions = {
      secret: SECRET,
      header: "x-signature",
      prefix: "sha512=",
      algo: "SHA-512",
      encoding: "base64",
    }
    expect(await body(options, request(BODY, { "x-signature": `sha512=${sig}` }))).toBe(BODY)
    const bare = await refusal(options, request(BODY, { "x-signature": sig }))
    expect(HeraWebhook.refusalReason(bare)).toBe("malformed_signature")
  })

  // admits: a fresh delivery refused as stale (unit or source mixed up); time arithmetic is runtime.
  it("accepts a fresh header timestamp in seconds and a fresh body timestamp", async () => {
    const sig = await sign(SECRET, BODY)
    const header: HeraWebhookOptions = {
      ...linear(SECRET),
      timestamp: { header: "x-timestamp", payload: slackPayload, unit: "s", toleranceMs: 60_000 },
    }
    const ts = String(Math.floor(NOW_MS / 1000) - 30)
    const signedTs = await sign(SECRET, `v0:${ts}:${BODY}`)
    expect(await body(header, request(BODY, { "linear-signature": signedTs, "x-timestamp": ts }))).toBe(BODY)
    const fromBody: HeraWebhookOptions = {
      ...linear(SECRET),
      timestamp: { read: (bytes) => JSON.parse(new TextDecoder().decode(bytes)).webhookTimestamp, toleranceMs: 60_000 },
    }
    expect(await body(fromBody, request(BODY, { "linear-signature": sig }))).toBe(BODY)
  })
})

describe("HeraWebhook.verifyHmac — refuses with one fixed 401", () => {
  const cases: Array<[string, () => Promise<[HeraWebhookOptions, Request]>, HeraWebhookRefusalReason]> = [
    ["tampered body", async () => [linear(SECRET), request(`${BODY} `, { "linear-signature": await sign(SECRET, BODY) })], "bad_signature"],
    ["wrong key", async () => [linear(SECRET), request(BODY, { "linear-signature": await sign("other", BODY) })], "bad_signature"],
    ["missing header", async () => [linear(SECRET), request(BODY, {})], "missing_signature"],
    ["short signature", async () => [linear(SECRET), request(BODY, { "linear-signature": (await sign(SECRET, BODY)).slice(2) })], "malformed_signature"],
    ["long signature", async () => [linear(SECRET), request(BODY, { "linear-signature": `${await sign(SECRET, BODY)}00` })], "malformed_signature"],
    ["non-hex signature", async () => [linear(SECRET), request(BODY, { "linear-signature": "z".repeat(64) })], "malformed_signature"],
    ["empty secret set", async () => [linear(["", "\n"]), request(BODY, { "linear-signature": await sign("other", BODY) })], "unconfigured"],
    ["stale header timestamp", async () => [{ ...linear(SECRET), timestamp: { header: "x-ts", payload: slackPayload, toleranceMs: 60_000 } }, request(BODY, { "linear-signature": await sign(SECRET, `v0:${String(NOW_MS - 60_001)}:${BODY}`), "x-ts": String(NOW_MS - 60_001) })], "stale"],
    ["future header timestamp", async () => [{ ...linear(SECRET), timestamp: { header: "x-ts", payload: slackPayload, toleranceMs: 60_000 } }, request(BODY, { "linear-signature": await sign(SECRET, `v0:${String(NOW_MS + 60_001)}:${BODY}`), "x-ts": String(NOW_MS + 60_001) })], "stale"],
    ["garbage header timestamp", async () => [{ ...linear(SECRET), timestamp: { header: "x-ts", payload: slackPayload, toleranceMs: 60_000 } }, request(BODY, { "linear-signature": await sign(SECRET, `v0:${"12a"}:${BODY}`), "x-ts": "12a" })], "stale"],
    ["missing header timestamp", async () => [{ ...linear(SECRET), timestamp: { header: "x-ts", payload: slackPayload, toleranceMs: 60_000 } }, request(BODY, { "linear-signature": await sign(SECRET, BODY) })], "missing_timestamp"],
    ["replayed delivery with a rewritten timestamp header", async () => {
      const oldTs = String(NOW_MS - 30 * 86_400_000)
      const captured = await sign(SECRET, `v0:${oldTs}:${BODY}`)
      return [{ ...linear(SECRET), timestamp: { header: "x-ts", payload: slackPayload, toleranceMs: 60_000 } }, request(BODY, { "linear-signature": captured, "x-ts": String(NOW_MS) })]
    }, "bad_signature"],
    ["body-only signature replayed with a fresh timestamp header", async () => [{ ...linear(SECRET), timestamp: { header: "x-ts", payload: slackPayload, toleranceMs: 60_000 } }, request(BODY, { "linear-signature": await sign(SECRET, BODY), "x-ts": String(NOW_MS) })], "bad_signature"],
    ["non-canonical base64 spelling", async () => {
      const sig = await sign(SECRET, BODY, "SHA-256", "base64")
      const last = sig.at(-2)!
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
      const variant = `${sig.slice(0, -2)}${alphabet[alphabet.indexOf(last) ^ 1]}=`
      return [{ ...linear(SECRET), encoding: "base64" }, request(BODY, { "linear-signature": variant })]
    }, "malformed_signature"],
    ["NaN body timestamp", async () => [{ ...linear(SECRET), timestamp: { read: () => Number.NaN, toleranceMs: 60_000 } }, request(BODY, { "linear-signature": await sign(SECRET, BODY) })], "stale"],
    ["Infinity body timestamp", async () => [{ ...linear(SECRET), timestamp: { read: () => Number.POSITIVE_INFINITY, toleranceMs: 60_000 } }, request(BODY, { "linear-signature": await sign(SECRET, BODY) })], "stale"],
    ["absent body timestamp", async () => [{ ...linear(SECRET), timestamp: { read: () => undefined, toleranceMs: 60_000 } }, request(BODY, { "linear-signature": await sign(SECRET, BODY) })], "missing_timestamp"],
  ]

  for (const [name, build, reason] of cases) {
    // admits: a refusal that leaks which check failed, a secret, the signature or the body, or lets a bad delivery through; response bytes and log lines are runtime.
    it(`${name} -> ${reason}`, async () => {
      const [options, req] = await build()
      const logged: Logged = []
      const error = await refusal(options, req, logged)
      expect(error.httpStatus).toBe(401)
      expect(HeraWebhook.refusalReason(error)).toBe(reason)
      expect(error.toProblemDetails()).toEqual(FIXED_401)
      const sig = req.headers.get("linear-signature") ?? ""
      const surfaces = [JSON.stringify(error), String(error), error.message, JSON.stringify(error.cause), String(error.cause), JSON.stringify(logged)]
      for (const text of surfaces) {
        for (const needle of [SECRET, BODY, ...(sig.length > 8 ? [sig] : [])]) {
          expect(text).not.toContain(needle)
        }
      }
    })
  }

  // admits: a short digest compared against a prefix, or crypto work spent on garbage; ordering is runtime.
  it("rejects malformed signatures before importing any key", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey")
    await refusal(linear(SECRET), request(BODY, { "linear-signature": "ab" }))
    expect(importKey).not.toHaveBeenCalled()
  })

  // admits: caller code parsing an unsigned body; call order is runtime.
  it("never calls the body timestamp reader when the signature fails", async () => {
    const read = vi.fn(() => NOW_MS)
    const options: HeraWebhookOptions = { ...linear(SECRET), timestamp: { read, toleranceMs: 60_000 } }
    await refusal(options, request(BODY, { "linear-signature": await sign("other", BODY) }))
    expect(read).not.toHaveBeenCalled()
  })

  // admits: `Date.now()` in place of the Effect clock, so tests and pinned clocks cannot drive staleness; both type-check as numbers.
  it("reads the tolerance against the Effect clock", async () => {
    const sig = await sign(SECRET, BODY)
    const options: HeraWebhookOptions = { ...linear(SECRET), timestamp: { read: () => NOW_MS, toleranceMs: 60_000 } }
    const program = Effect.gen(function* () {
      yield* HeraTest.setClock(NOW_MS + 120_000)
      return yield* Effect.exit(HeraWebhook.verifyHmac(options)(request(BODY, { "linear-signature": sig })))
    })
    const exit = await HeraTest.runTest(program, HeraTest.layer({ initialTimeMs: NOW_MS }))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  // admits: an unbounded body read before HMAC; stream length is runtime.
  it("refuses a body over maxBytes with 413, declared or streamed", async () => {
    const big = "x".repeat(65)
    const sig = await sign(SECRET, big)
    const options: HeraWebhookOptions = { ...linear(SECRET), maxBytes: 64 }
    const streamed = await refusal(options, request(big, { "linear-signature": sig }))
    expect(streamed.httpStatus).toBe(413)
    expect(streamed.code).toBe("payload_too_large")
    expect(HeraWebhook.refusalReason(streamed)).toBe("too_large")
    const declared = await refusal(options, request(big, { "linear-signature": sig, "content-length": "65" }))
    expect(HeraWebhook.refusalReason(declared)).toBe("too_large")
  })
})

describe("HeraWebhook.verifyHmac — construction", () => {
  // admits: a misconfigured verifier that silently refuses every delivery, or an untyped caller passing an unsigned header timestamp; option values are runtime.
  it("throws on an empty header, a non-positive maxBytes or toleranceMs", () => {
    expect(() => HeraWebhook.verifyHmac({ secret: SECRET, header: "" })).toThrow()
    expect(() => HeraWebhook.verifyHmac({ ...linear(SECRET), maxBytes: 0 })).toThrow()
    expect(() =>
      HeraWebhook.verifyHmac({ ...linear(SECRET), timestamp: { header: "x-ts", payload: slackPayload, toleranceMs: -1 } }),
    ).toThrow()
    const unsigned = { header: "x-ts", toleranceMs: 60_000 } as unknown as HeraWebhookOptions["timestamp"]
    expect(() => HeraWebhook.verifyHmac({ ...linear(SECRET), timestamp: unsigned })).toThrow(/payload/)
  })

  // admits: another error misread as a webhook refusal; `cause` is `unknown` at the type level.
  it("refusalReason is undefined for an unrelated error", () => {
    expect(HeraWebhook.refusalReason(HeraError.unauthorized())).toBeUndefined()
    expect(HeraWebhook.refusalReason(new Error("x"))).toBeUndefined()
  })
})
