import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
  fromHttpRpcReply,
  fromHttpRpcRequest,
  Hera,
  HeraError,
  type HttpRpcReply,
  type HttpRpcRequest,
  toHttpRpcReply,
  toHttpRpcRequest,
} from "../src/index"

const bytes = (n: number) => new Uint8Array(n).fill(7)

/** A body stream of `chunks` chunks of `size` bytes that counts how many chunks were pulled. */
function countingStream(chunks: number, size: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++
      controller.enqueue(bytes(size))
      if (pulled >= chunks) controller.close()
    },
  })
  return { stream, pulled: () => pulled }
}

async function rejection(promise: Promise<unknown>): Promise<HeraError> {
  const caught = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(HeraError.is(caught)).toBe(true)
  return caught as HeraError
}

describe("HTTP-over-RPC envelopes", () => {
  // admits: boundary-io: Headers iteration and ArrayBuffer slicing are runtime behaviour no type sees
  it("round-trips method, url, repeated headers and body bytes", async () => {
    const original = new Request("https://svc.test/v1/things?q=1", {
      method: "POST",
      headers: [["content-type", "application/json"], ["x-tag", "a"], ["x-tag", "b"]],
      body: JSON.stringify({ hello: "world" }),
    })
    const envelope = await toHttpRpcRequest(original)
    expect(envelope.method).toBe("POST")
    expect(envelope.headers).toContainEqual(["x-tag", "a, b"])
    const rebuilt = fromHttpRpcRequest(structuredClone(envelope))
    expect(rebuilt.url).toBe("https://svc.test/v1/things?q=1")
    expect(rebuilt.headers.get("content-type")).toBe("application/json")
    expect(await rebuilt.json()).toEqual({ hello: "world" })
  })

  // admits: boundary-io: Headers combines repeated headers except set-cookie, which must survive as separate pairs
  it("keeps each set-cookie of a reply", async () => {
    const headers = new Headers()
    headers.append("set-cookie", "a=1")
    headers.append("set-cookie", "b=2")
    const reply = await toHttpRpcReply(new Response("ok", { status: 201, headers }))
    expect(reply.headers.filter(([name]) => name === "set-cookie")).toEqual([["set-cookie", "a=1"], ["set-cookie", "b=2"]])
    const response = fromHttpRpcReply(structuredClone(reply))
    expect(response.status).toBe(201)
    expect((response.headers as Headers & { getSetCookie(): Array<string> }).getSetCookie()).toEqual(["a=1", "b=2"])
    expect(await response.text()).toBe("ok")
  })

  // admits: algorithmic: the null-body branch; `new Response(body, { status: 204 })` throws
  it("carries null bodies for GET/HEAD and null-body statuses", async () => {
    expect((await toHttpRpcRequest(new Request("https://svc.test/", { method: "HEAD" }))).body).toBeNull()
    for (const status of [204, 205, 304]) {
      const reply = await toHttpRpcReply(new Response(null, { status }))
      expect(reply.body).toBeNull()
      const forged: HttpRpcReply = { status, headers: [], body: new ArrayBuffer(3) }
      expect(fromHttpRpcReply(forged).status).toBe(status)
    }
  })

  // admits: algorithmic: the off-by-one cap boundary and that the stream is not read past the cap
  it("accepts maxBytes, refuses maxBytes + 1 with 413 without reading past the cap", async () => {
    const at = await toHttpRpcRequest(new Request("https://svc.test/", { method: "POST", body: bytes(10) }), { maxBytes: 10 })
    expect(at.body?.byteLength).toBe(10)

    const over = await rejection(toHttpRpcRequest(new Request("https://svc.test/", { method: "POST", body: bytes(11) }), { maxBytes: 10 }))
    expect(over.code).toBe("payload_too_large")
    expect(over.httpStatus).toBe(413)

    const { stream, pulled } = countingStream(1000, 4)
    const streamed = new Request("https://svc.test/", { method: "POST", body: stream, duplex: "half" } as RequestInit)
    expect((await rejection(toHttpRpcRequest(streamed, { maxBytes: 10 }))).httpStatus).toBe(413)
    expect(pulled()).toBeLessThan(10)
  })

  // admits: algorithmic: a declared content-length over the cap is refused before any byte is read
  it("refuses a declared over-cap content-length before reading", async () => {
    const { stream, pulled } = countingStream(1000, 4)
    const declared = new Request("https://svc.test/", {
      method: "POST",
      headers: { "content-length": "999" },
      body: stream,
      duplex: "half",
    } as RequestInit)
    expect((await rejection(toHttpRpcRequest(declared, { maxBytes: 10 }))).code).toBe("payload_too_large")
    expect(pulled()).toBeLessThanOrEqual(1)
  })

  // admits: integration: a rolling deploy sends either shape, and both must read
  it("dual-reads raw Request and Response", () => {
    const request = new Request("https://svc.test/")
    const response = new Response("x")
    expect(fromHttpRpcRequest(request)).toBe(request)
    expect(fromHttpRpcReply(response)).toBe(response)
    expect(() => fromHttpRpcRequest({ nope: true } as unknown as HttpRpcRequest)).toThrow(HeraError)
  })
})

describe("Hera.httpRpcMethod / Hera.httpRpcClient", () => {
  const echo = Hera.router([
    Hera.publicRoute({
      method: "POST",
      path: "/echo",
      service: "echo",
      handler: ({ request }) =>
        Effect.promise(async () => new Response(await request.text(), { status: 200, headers: { "x-echo": "1" } })),
    }),
  ])
  const handle = Hera.httpRpcMethod("handle", { service: "echo", router: echo })

  // admits: integration: the wrapper over rpcMethod answers an envelope for both input shapes and refuses garbage
  it("answers an HttpRpcReply for an envelope or a raw Request, and 400 for anything else", async () => {
    const envelope = await toHttpRpcRequest(new Request("https://echo.test/echo", { method: "POST", body: "hi" }))
    const viaEnvelope = await handle(envelope)
    expect(viaEnvelope.ok).toBe(true)
    if (viaEnvelope.ok) {
      expect(viaEnvelope.value.status).toBe(200)
      expect(new TextDecoder().decode(viaEnvelope.value.body!)).toBe("hi")
    }
    const viaRaw = await handle(new Request("https://echo.test/echo", { method: "POST", body: "raw" }))
    expect(viaRaw.ok && new TextDecoder().decode(viaRaw.value.body!)).toBe("raw")
    const garbage = await handle({ nope: true } as unknown as HttpRpcRequest)
    expect(garbage).toMatchObject({ ok: false, status: 400, code: "invalid_rpc_input" })
  })

  // admits: integration: an oversize reply fails closed as 502 instead of throwing in the transport
  it("answers 502 bad_gateway for a reply over the cap", async () => {
    const big = Hera.httpRpcMethod("handle", {
      service: "big",
      maxBytes: 4,
      handler: () => Effect.succeed(new Response("too large")),
    })
    expect(await big(await toHttpRpcRequest(new Request("https://big.test/")))).toMatchObject({ ok: false, status: 502, code: "bad_gateway" })
  })

  // admits: integration: client and method compose end to end in process, including a router 404
  it("forwards through the client and answers the callee's Response", async () => {
    const client = Hera.httpRpcClient({ handle })
    const ok = await Effect.runPromise(client.fetch(new Request("https://echo.test/echo", { method: "POST", body: "x" })))
    expect(ok.status).toBe(200)
    expect(ok.headers.get("x-echo")).toBe("1")
    expect(await ok.text()).toBe("x")
    const missing = await Effect.runPromise(client.fetch(new Request("https://echo.test/nope")))
    expect(missing.status).toBe(404)
  })

  // admits: integration: an oversize request fails 413 before the binding is called
  it("fails 413 before calling the binding", async () => {
    let calls = 0
    const client = Hera.httpRpcClient({ handle: (input: HttpRpcRequest) => { calls++; return handle(input) } }, { maxBytes: 2 })
    const error = await Effect.runPromise(Effect.flip(client.fetch(new Request("https://echo.test/echo", { method: "POST", body: "xyz" }))))
    expect(error.httpStatus).toBe(413)
    expect(calls).toBe(0)
  })

  // admits: integration: isHeraRpcResult reads a raw 4xx Response as a failure envelope; the client must normalise it first
  it("reads a raw Response and a bare HttpRpcReply from a callee on the previous shape", async () => {
    const raw = Hera.httpRpcClient({ handle: async () => new Response("gone", { status: 404 }) })
    const fromRaw = await Effect.runPromise(raw.fetch(new Request("https://old.test/")))
    expect(fromRaw.status).toBe(404)
    expect(await fromRaw.text()).toBe("gone")

    const bareReply: HttpRpcReply = { status: 418, headers: [["x-bare", "1"]], body: new TextEncoder().encode("tea").buffer as ArrayBuffer }
    const bare = Hera.httpRpcClient({ handle: async () => bareReply })
    const fromBare = await Effect.runPromise(bare.fetch(new Request("https://old.test/")))
    expect(fromBare.status).toBe(418)
    expect(await fromBare.text()).toBe("tea")
  })
})
