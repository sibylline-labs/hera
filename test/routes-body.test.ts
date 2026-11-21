import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Hera } from "../src/index"
import { makeTestTenantCtx, SAMPLE_IDS } from "../src/testing/index"

const CAP = 4096

// A body the schema would refuse (400 invalid_request_body): a 413 proves the cap ran first.
const Body = Schema.Struct({ device_code: Schema.NonEmptyString })

function streamOf(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024).fill(0x61)
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close()
      const size = Math.min(chunk.byteLength, bytes - sent)
      controller.enqueue(chunk.subarray(0, size))
      sent += size
    },
  })
}

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("https://api.example.com/device/token", {
    method: "POST",
    headers: { "x-request-id": SAMPLE_IDS.requestId, ...headers },
    body,
    duplex: "half",
  } as RequestInit)
}

async function problemOf(res: Response): Promise<Record<string, unknown>> {
  expect(res.headers.get("content-type")).toContain("application/problem+json")
  return (await res.json()) as Record<string, unknown>
}

describe("route boundary request body: maxBodyBytes and bodyFormat", () => {
  let handlerRuns = 0
  const Capped = Hera.publicRoute({
    name: "Device.token",
    method: "POST",
    maxBodyBytes: CAP,
    bodyFormat: "json-or-form",
    body: Body,
    handler: ({ body }) =>
      Effect.sync(() => {
        handlerRuns += 1
        return { device_code: body.device_code }
      }),
  })

  // admits: a declared over-cap body read or decoded before the 413; byte counts are runtime, no type sees them
  it("refuses a declared content-length over the cap with 413 before reading or decoding", async () => {
    const res = await Capped.handle(
      post("x".repeat(CAP + 1), { "content-length": String(CAP + 1) })
    )
    expect(res.status).toBe(413)
    const problem = await problemOf(res)
    expect(problem.code).toBe("payload_too_large")
    expect(problem.request_id).toBe(SAMPLE_IDS.requestId)
  })

  // admits: an unlengthed stream read past the cap (workerd may hide content-length); runtime-only
  it("refuses a streamed body with no content-length that passes the cap with 413", async () => {
    const before = handlerRuns
    const res = await Capped.handle(post(streamOf(CAP + 1)))
    expect(res.status).toBe(413)
    expect((await problemOf(res)).code).toBe("payload_too_large")
    expect(handlerRuns).toBe(before)
  })

  // admits: an off-by-one cap refusing a body of exactly maxBodyBytes; runtime-only
  it("reads a body of exactly the cap and decodes it through the schema", async () => {
    const value = "a".repeat(CAP - '{"device_code":""}'.length)
    const res = await Capped.handle(
      post(JSON.stringify({ device_code: value }), {
        "content-type": "application/json",
      })
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { device_code: string }).device_code).toBe(value)
  })

  // admits: a form body (with ;charset) not reaching the body schema on an opted-in route; runtime-only
  it("decodes an application/x-www-form-urlencoded body through the same schema", async () => {
    const res = await Capped.handle(
      post("device_code=GmRh-mJ&grant_type=x", {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      })
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { device_code: string }).device_code).toBe("GmRh-mJ")
  })

  // admits: a form record bypassing the body schema; runtime-only
  it("runs the schema over a form body and refuses a missing field with 400 invalid_request_body", async () => {
    const res = await Capped.handle(
      post("grant_type=x", { "content-type": "application/x-www-form-urlencoded" })
    )
    expect(res.status).toBe(400)
    expect((await problemOf(res)).code).toBe("invalid_request_body")
  })

  // admits: the form decode leaking onto routes that did not opt in (default changed); runtime-only
  it("answers invalid_json for a form body on a route that did not opt in", async () => {
    const JsonOnly = Hera.publicRoute({
      name: "Device.jsonOnly",
      method: "POST",
      body: Body,
      handler: ({ body }) => Effect.succeed(body),
    })
    const res = await JsonOnly.handle(
      post("device_code=abc", { "content-type": "application/x-www-form-urlencoded" })
    )
    expect(res.status).toBe(400)
    expect((await problemOf(res)).code).toBe("invalid_json")
  })

  // admits: authedRoute dropping the cap that publicRoute applies; runtime-only
  it("caps an authedRoute body the same way", async () => {
    const AuthedCapped = Hera.authedRoute({
      name: "Linear.exchange",
      method: "POST",
      maxBodyBytes: CAP,
      body: Body,
      handler: ({ body }) => Effect.succeed(body),
    })
    const res = await AuthedCapped.handle(post(streamOf(CAP + 1)), {
      tenant: makeTestTenantCtx(),
    })
    expect(res.status).toBe(413)
    expect((await problemOf(res)).code).toBe("payload_too_large")
  })

  // admits: a non-positive or fractional cap accepted silently; TS has no positive-integer number type
  it("throws at construction on a maxBodyBytes that is not a positive integer", () => {
    for (const maxBodyBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        Hera.publicRoute({
          maxBodyBytes,
          body: Body,
          handler: ({ body }) => Effect.succeed(body),
        })
      ).toThrow(/maxBodyBytes must be a positive integer/)
    }
  })
})
