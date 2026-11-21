import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import {
  HeraBodyReadError,
  HeraHttp,
  readBody,
  type HeraReadBodyOptions,
} from "../src/core/http/index"

const CAP = 64

/** A stream of `bytes` bytes in 16-byte chunks that counts what the reader pulled. */
function countingStream(bytes: number) {
  const seen = { pulled: 0, cancelled: false }
  let sent = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= bytes) return controller.close()
        const size = Math.min(16, bytes - sent)
        controller.enqueue(new Uint8Array(size).fill(0x61))
        sent += size
        seen.pulled += size
      },
      cancel() {
        seen.cancelled = true
      },
    },
    { highWaterMark: 0 }
  )
  return { stream, seen }
}

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.example/v1/device/token", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit)
}

const JSON_CAP: HeraReadBodyOptions = { maxBytes: CAP, format: "json" }
const FORM_CAP: HeraReadBodyOptions = { maxBytes: CAP, format: "json-or-form" }

async function reasonOf(request: Request, options: HeraReadBodyOptions): Promise<string> {
  const exit = await Effect.runPromiseExit(readBody(request, options))
  if (Exit.isSuccess(exit)) throw new Error(`expected a refusal, got ${JSON.stringify(exit.value)}`)
  const error = Cause.findErrorOption(exit.cause)
  if (error._tag !== "Some") throw new Error(`expected a typed failure, got ${Cause.pretty(exit.cause)}`)
  expect(error.value).toBeInstanceOf(HeraBodyReadError)
  return error.value.reason
}

describe("HeraHttp.readBody — a handler-callable capped body read", () => {
  // admits: a declared over-cap body being read at all; the pull count is runtime-only
  it("refuses a declared content-length over the cap as too_large before reading a byte", async () => {
    const { stream, seen } = countingStream(CAP * 4)
    const request = post(stream, { "content-length": String(CAP * 4) })
    expect(await reasonOf(request, JSON_CAP)).toBe("too_large")
    expect(seen.pulled).toBe(0)
  })

  // admits: an unlengthed stream buffered past the cap (workerd may hide content-length)
  it("refuses a streamed body past the cap as too_large and stops reading at the cap", async () => {
    const { stream, seen } = countingStream(CAP * 16)
    expect(await reasonOf(post(stream), JSON_CAP)).toBe("too_large")
    expect(seen.pulled).toBeLessThanOrEqual(CAP + 16)
    expect(seen.cancelled).toBe(true)
  })

  // admits: an off-by-one refusing a body of exactly maxBytes; a byte count is runtime-only
  it("reads a body of exactly the cap", async () => {
    const text = JSON.stringify({ k: "v".repeat(CAP - 8) })
    expect(text.length).toBe(CAP)
    expect(await Effect.runPromise(readBody(post(text), JSON_CAP))).toEqual({ k: "v".repeat(CAP - 8) })
  })

  // admits: a non-object or unparsable body passed to the caller as a value, or thrown; the parse is runtime
  it.each([
    ["malformed JSON", "{not json"],
    ["an empty body", ""],
    ["a JSON array", "[1,2]"],
    ["a JSON scalar", "42"],
    ["JSON null", "null"],
  ])("refuses %s as malformed", async (_label, body) => {
    expect(await reasonOf(post(body, { "content-type": "application/json" }), JSON_CAP)).toBe(
      "malformed"
    )
  })

  // admits: a form body decoded on a route that did not opt in; content-type is runtime
  it("refuses a form body under format json as malformed", async () => {
    const request = post("device_code=abc", {
      "content-type": "application/x-www-form-urlencoded",
    })
    expect(await reasonOf(request, JSON_CAP)).toBe("malformed")
  })

  // admits: the form decode dropping, nesting or not percent-decoding a field (RFC 8628 §3.4); runtime
  it("decodes a form body under json-or-form to a flat string record", async () => {
    const request = post("grant_type=device_code&device_code=abc%20def", {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    })
    expect(await Effect.runPromise(HeraHttp.readBody(request, FORM_CAP))).toEqual({
      grant_type: "device_code",
      device_code: "abc def",
    })
  })

  // admits: json-or-form refusing a JSON body; the content-type branch is runtime
  it("decodes a JSON object under json-or-form", async () => {
    const request = post(JSON.stringify({ device_code: "abc" }), {
      "content-type": "application/json",
    })
    expect(await Effect.runPromise(readBody(request, FORM_CAP))).toEqual({ device_code: "abc" })
  })

  // admits: the form branch skipping the cap; byte counts are runtime-only
  it("caps a form body too", async () => {
    const request = post(`a=${"x".repeat(CAP)}`, {
      "content-type": "application/x-www-form-urlencoded",
    })
    expect(await reasonOf(request, FORM_CAP)).toBe("too_large")
  })

  // admits: an uncapped read when maxBytes is 0, negative or fractional; number is the type, not positive int
  it.each([0, -1, 1.5, Number.NaN])("dies on a maxBytes of %s (the cap is mandatory)", async (maxBytes) => {
    const exit = await Effect.runPromiseExit(readBody(post("{}"), { maxBytes, format: "json" }))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })
})
