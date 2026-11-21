import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { gunzipBase64Bounded, gunzipBounded } from "../src/core/http/index"
import { HeraHttp } from "../src/index"

const BOMB_BYTES = 16 * 1024 * 1024

async function gzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Wraps the real decoder so a test sees how many bytes it emitted and whether it was cancelled. */
function spyDecoder() {
  const seen = { emitted: 0, lastChunk: 0, cancelled: false }
  const Real = DecompressionStream
  class Spy {
    readonly writable: WritableStream<BufferSource>
    readonly readable: ReadableStream<Uint8Array>
    constructor(format: ConstructorParameters<typeof DecompressionStream>[0]) {
      const real = new Real(format)
      const reader = real.readable.getReader()
      this.writable = real.writable
      this.readable = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const read = await reader.read()
            if (read.done) return controller.close()
            seen.emitted += read.value.byteLength
            seen.lastChunk = read.value.byteLength
            controller.enqueue(read.value)
          },
          async cancel(reason) {
            seen.cancelled = true
            await reader.cancel(reason)
          },
        },
        { highWaterMark: 0 }
      )
    }
  }
  vi.stubGlobal("DecompressionStream", Spy)
  return seen
}

const text = new TextEncoder().encode("plan: ABC-3495\n".repeat(200))
let textGz: Uint8Array<ArrayBuffer>
let bombGz: Uint8Array<ArrayBuffer>

beforeAll(async () => {
  textGz = await gzip(text)
  bombGz = await gzip(new Uint8Array(BOMB_BYTES))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("gunzipBounded", () => {
  // admits: a decode that drops or reorders chunks; output bytes are runtime, no type holds them
  it("round-trips gzip bytes", async () => {
    expect(await gunzipBounded(textGz, text.byteLength)).toEqual(text)
  })

  // admits: an off-by-one at the limit (`>=` for `>`); a comparison is runtime
  it("accepts output of exactly the limit and refuses one byte less", async () => {
    expect((await gunzipBounded(textGz, text.byteLength))?.byteLength).toBe(text.byteLength)
    expect(await gunzipBounded(textGz, text.byteLength - 1)).toBeNull()
  })

  // admits: a loop that buffers the whole bomb before checking, or never cancels the decoder; stream behaviour is runtime
  it("cancels a gzip bomb before buffering past the limit", async () => {
    const seen = spyDecoder()
    const limit = 1024
    expect(await gunzipBounded(bombGz, limit)).toBeNull()
    expect(seen.cancelled).toBe(true)
    expect(seen.emitted - seen.lastChunk).toBeLessThan(limit)
    expect(seen.emitted).toBeLessThan(BOMB_BYTES)
  })

  // admits: corrupt input read as a short valid output; the decoder error path is runtime
  it("rejects corrupt gzip rather than returning short output", async () => {
    await expect(gunzipBounded(new Uint8Array([1, 2, 3, 4]), 1024)).rejects.toThrow()
  })

  // admits: a NaN or fractional limit that makes every `>` false and buffers unbounded; `number` cannot exclude it
  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])("throws RangeError on limit %s", async (limit) => {
    await expect(gunzipBounded(textGz, limit)).rejects.toThrow(RangeError)
  })
})

describe("gunzipBase64Bounded", () => {
  // admits: a base64 decode that mangles bytes >= 0x80; byte mapping is runtime
  it("round-trips base64 of gzip", async () => {
    expect(await gunzipBase64Bounded(toBase64(textGz), text.byteLength)).toEqual(text)
  })

  // admits: the variant dropping the limit on its way to gunzipBounded; runtime
  it("returns null past the limit", async () => {
    expect(await gunzipBase64Bounded(toBase64(bombGz), 1024)).toBeNull()
  })

  // admits: invalid base64 decoded to garbage instead of rejecting; runtime
  it("rejects invalid base64", async () => {
    await expect(gunzipBase64Bounded("!!not base64", 1024)).rejects.toThrow()
  })
})

describe("HeraHttp namespace", () => {
  // admits: the namespace missing a member; `as const` object membership is not checked against the barrel
  it("carries both functions", () => {
    expect(HeraHttp.gunzipBounded).toBe(gunzipBounded)
    expect(HeraHttp.gunzipBase64Bounded).toBe(gunzipBase64Bounded)
  })
})
