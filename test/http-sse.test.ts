import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { describe, expect, it } from "vitest"
import { Hera, HeraHttp, type HeraSseOutcome, sseCommentFrame, sseDataFrame } from "../src/index"
import { advanceClock, makeTestLayer, makeTestTenantCtx, runTest, SAMPLE_IDS } from "../src/testing/index"

const UPSTREAM = {
  messages: { upstream_failed: "Upstream request failed", upstream_timeout: "Upstream timed out" },
  classify: (cause: unknown) =>
    cause instanceof Error && cause.name === "TimeoutError" ? ("upstream_timeout" as const) : ("upstream_failed" as const),
}

/** A source the test feeds by hand: `push` a value, `end` it, or `fail` it; `signal` is what the writer handed the factory. */
function channel<A>() {
  const queue: Array<IteratorResult<A> | { error: unknown }> = []
  let wake: (() => void) | undefined
  const state = { signal: undefined as AbortSignal | undefined, returned: false }
  const put = (item: IteratorResult<A> | { error: unknown }) => {
    queue.push(item)
    wake?.()
  }
  async function* iterate(): AsyncGenerator<A> {
    try {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
        const item = queue.shift()!
        if ("error" in item) throw item.error
        if (item.done === true) return
        yield item.value
      }
    } finally {
      state.returned = true
    }
  }
  return {
    state,
    source: (signal: AbortSignal) => {
      state.signal = signal
      return iterate()
    },
    push: (value: A) => put({ done: false, value }),
    end: () => put({ done: true, value: undefined }),
    fail: (error: unknown) => put({ error }),
  }
}

const decoder = new TextDecoder()
const text = async (res: Response) => decoder.decode(await res.arrayBuffer())
const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const { value } = await reader.read()
  return value === undefined ? undefined : decoder.decode(value)
}

function sseRoute<C extends string>(build: () => Effect.Effect<Response>) {
  return Hera.authedRoute({ method: "POST", path: "/v1/chat/completions", handler: () => build() })
}

const post = () =>
  new Request("https://gateway.example/v1/chat/completions", {
    method: "POST",
    headers: { "x-request-id": SAMPLE_IDS.requestId },
  })

describe("HeraHttp.sse — a Server-Sent Events response writer", () => {
  // admits: the route boundary rebuilding the writer's Response (headers dropped, body consumed or
  // re-wrapped); only the runtime bytes after serializeSuccessResponse show it.
  it("answers through an authedRoute as 200 text/event-stream: data frames, then the sentinel", async () => {
    const outcomes: Array<HeraSseOutcome<string>> = []
    const route = sseRoute(() =>
      HeraHttp.sse(Stream.make({ id: "c1", n: 1 }, { id: "c1", n: 2 }), {
        sentinel: "[DONE]",
        onEnd: (outcome) => outcomes.push(outcome),
      })
    )
    const res = await route(post(), { tenant: makeTestTenantCtx() })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-request-id")).toBe(SAMPLE_IDS.requestId)
    expect(await text(res)).toBe('data: {"id":"c1","n":1}\n\ndata: {"id":"c1","n":2}\n\ndata: [DONE]\n\n')
    expect(outcomes).toEqual([{ _tag: "done" }])
  })

  // admits: a mid-stream failure ending in [DONE] (a cut-off answer read as complete) or echoing the
  // thrown message onto the wire; the order and bytes exist only at runtime.
  it("writes the error frame instead of the sentinel when the source fails after headers flushed", async () => {
    const ch = channel<{ n: number }>()
    const outcomes: Array<HeraSseOutcome<string>> = []
    const route = sseRoute(() =>
      HeraHttp.sse(ch.source, { sentinel: "[DONE]", errors: UPSTREAM, onEnd: (o) => outcomes.push(o) })
    )
    const res = await route(post(), { tenant: makeTestTenantCtx() })
    ch.push({ n: 1 })
    ch.fail(new Error("connect ECONNREFUSED postgres://admin:secret-db-url@10.0.0.4"))

    const body = await text(res)
    expect(body).toBe(
      'data: {"n":1}\n\ndata: {"error":{"code":"upstream_failed","message":"Upstream request failed"}}\n\n'
    )
    expect(body).not.toContain("secret-db-url")
    expect(body).not.toContain("[DONE]")
    expect(outcomes).toEqual([{ _tag: "failed", code: "upstream_failed" }])
    expect(ch.state.signal?.aborted).toBe(true)
  })

  // admits: a framing defect (a value with no JSON form) escaping as a broken stream or a raw
  // TypeError message instead of the default error frame; runtime only.
  it("ends a framing defect with the default error frame", async () => {
    const res = await runTest(HeraHttp.sse(Stream.make({ ok: 1 }, { big: 1n }), { sentinel: "[DONE]" }))
    expect(await text(res)).toBe(
      'data: {"ok":1}\n\ndata: {"error":{"code":"stream_failed","message":"Stream failed"}}\n\n'
    )
  })

  // admits: a classify that returns a code outside the table (a cast, or a cause's text) putting
  // free text on the wire, or one that throws breaking the frame; the type stops neither once cast.
  it("writes only a code and message from the table, whatever classify returns", async () => {
    const fail = Stream.concat(Stream.make(1), Stream.fail(new Error("SECRET-msg")))
    const offTable = await runTest(
      HeraHttp.sse(fail, {
        errors: { messages: { a: "A failed" }, classify: (cause) => (cause as Error).message as "a" },
      })
    )
    expect(await text(offTable)).toBe('data: 1\n\ndata: {"error":{"code":"a","message":"A failed"}}\n\n')

    const empty = await runTest(
      HeraHttp.sse(fail, {
        errors: {
          messages: {} as Record<"a", string>,
          classify: () => {
            throw new Error("SECRET-classify")
          },
        },
      })
    )
    expect(await text(empty)).toBe('data: 1\n\ndata: {"error":{"code":"stream_failed","message":"Stream failed"}}\n\n')
  })

  // admits: a throwing onEnd (a metrics callback) erroring a stream that already sent its sentinel;
  // runtime only.
  it("keeps a completed stream intact when onEnd throws", async () => {
    const res = await runTest(
      HeraHttp.sse(Stream.make(1), {
        sentinel: "[DONE]",
        onEnd: () => {
          throw new Error("onEnd boom")
        },
      })
    )
    expect(await text(res)).toBe("data: 1\n\ndata: [DONE]\n\n")
  })

  // admits: client disconnect leaving upstream work running; only the runtime cancel path shows it.
  it("aborts the source's signal and reports cancelled once when the response body is cancelled", async () => {
    const ch = channel<{ n: number }>()
    const outcomes: Array<HeraSseOutcome<string>> = []
    const route = sseRoute(() => HeraHttp.sse(ch.source, { sentinel: "[DONE]", onEnd: (o) => outcomes.push(o) }))
    const res = await route(post(), { tenant: makeTestTenantCtx() })
    const reader = res.body!.getReader()
    ch.push({ n: 1 })
    expect(await readChunk(reader)).toBe('data: {"n":1}\n\n')

    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ch.state.signal?.aborted).toBe(true)
    expect(outcomes).toEqual([{ _tag: "cancelled" }])
  })

  // admits: workerd never cancelling the body on a client disconnect, so the request's signal must
  // end the stream; runtime only.
  it("ends as cancelled, with no error frame or sentinel, when the disconnect signal aborts", async () => {
    const ch = channel<{ n: number }>()
    const disconnect = new AbortController()
    const deadline = new AbortController()
    const outcomes: Array<HeraSseOutcome<string>> = []
    const res = await runTest(
      HeraHttp.sse(ch.source, {
        sentinel: "[DONE]",
        errors: UPSTREAM,
        disconnect: disconnect.signal,
        signal: deadline.signal,
        onEnd: (o) => outcomes.push(o),
      })
    )
    const reader = res.body!.getReader()
    ch.push({ n: 1 })
    expect(await readChunk(reader)).toBe('data: {"n":1}\n\n')

    disconnect.abort()
    deadline.abort(new Error("late deadline"))
    expect(await readChunk(reader)).toBeUndefined()
    expect(ch.state.signal?.aborted).toBe(true)
    expect(outcomes).toEqual([{ _tag: "cancelled" }])
  })

  // admits: an already-gone client still starting upstream work; runtime only.
  it("writes nothing and never builds the source when the disconnect signal is already aborted", async () => {
    let built = false
    const outcomes: Array<HeraSseOutcome<string>> = []
    const res = await runTest(
      HeraHttp.sse(
        () => {
          built = true
          return Stream.make(1)
        },
        { disconnect: AbortSignal.abort(), onEnd: (o) => outcomes.push(o) }
      )
    )
    expect(await text(res)).toBe("")
    expect(built).toBe(false)
    expect(outcomes).toEqual([{ _tag: "cancelled" }])
  })

  // admits: a deadline or lost lease ending the stream silently or with [DONE]; runtime only.
  it("turns an aborted signal into the classified error frame", async () => {
    const ch = channel<{ n: number }>()
    const deadline = new AbortController()
    const res = await runTest(HeraHttp.sse(ch.source, { sentinel: "[DONE]", errors: UPSTREAM, signal: deadline.signal }))
    const reader = res.body!.getReader()
    ch.push({ n: 1 })
    expect(await readChunk(reader)).toBe('data: {"n":1}\n\n')

    deadline.abort(Object.assign(new Error("deadline passed"), { name: "TimeoutError" }))
    expect(await readChunk(reader)).toBe('data: {"error":{"code":"upstream_timeout","message":"Upstream timed out"}}\n\n')
    expect(await readChunk(reader)).toBeUndefined()
  })

  // admits: keepalives on wall time (untestable, flaky) or written while frames flow; only the
  // fiber's clock inside the returned ReadableStream shows the timing.
  it("writes a keepalive comment per idle interval on the test clock, and none after a frame", async () => {
    const ch = channel<{ n: number }>()
    await runTest(
      Effect.gen(function* () {
        const res = yield* HeraHttp.sse(ch.source, { keepalive: { interval: "15 seconds", comment: "queued" } })
        const reader = res.body!.getReader()

        const first = reader.read()
        yield* advanceClock("15 seconds")
        expect(decoder.decode((yield* Effect.promise(() => first)).value)).toBe(": queued\n\n")

        ch.push({ n: 1 })
        expect(yield* Effect.promise(() => readChunk(reader))).toBe('data: {"n":1}\n\n')
        yield* advanceClock("15 seconds")
        ch.push({ n: 2 })
        expect(yield* Effect.promise(() => readChunk(reader))).toBe('data: {"n":2}\n\n')

        const idle = reader.read()
        yield* advanceClock("15 seconds")
        yield* advanceClock("15 seconds")
        expect(decoder.decode((yield* Effect.promise(() => idle)).value)).toBe(": queued\n\n")
        yield* Effect.promise(() => reader.cancel())
      }),
      makeTestLayer()
    )
  })

  // admits: an Effect Stream source framed differently from an AsyncIterable one; runtime bytes.
  it("frames an AsyncIterable the same as an Effect Stream", async () => {
    async function* values() {
      yield [1, 2]
      yield "two"
    }
    const fromIterable = await runTest(HeraHttp.sse(values()))
    const fromStream = await runTest(HeraHttp.sse(Stream.make([1, 2], "two")))
    expect(await text(fromIterable)).toBe('data: [1,2]\n\ndata: "two"\n\n')
    expect(await text(fromStream)).toBe('data: [1,2]\n\ndata: "two"\n\n')
  })

  // admits: a CR/LF in an option splitting a frame (a forged event on the client); option strings are
  // values, so no type holds it.
  it("refuses a sentinel or keepalive comment that would split a frame", async () => {
    await expect(runTest(HeraHttp.sse(Stream.empty, { sentinel: "[DONE]\n\ndata: x" }))).rejects.toThrow(TypeError)
    await expect(
      runTest(HeraHttp.sse(Stream.empty, { keepalive: { interval: 1000, comment: "a\rb" } }))
    ).rejects.toThrow(TypeError)
    expect(() => sseCommentFrame("a\nb")).toThrow(TypeError)
    expect(() => sseDataFrame(undefined)).toThrow(TypeError)
    expect(sseDataFrame({ s: "line1\nline2" })).toBe('data: {"s":"line1\\nline2"}\n\n')
  })
})
