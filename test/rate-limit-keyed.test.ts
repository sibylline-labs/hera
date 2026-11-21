import { describe, expect, it } from "vitest"
import { makeKeyedBuckets as fromCore } from "../src/core/index"
import { HeraRateLimit } from "../src/index"

const T0 = 1_760_000_000_000
const LIMIT = { capacity: 10, refillPerSecond: 2 }

describe("HeraRateLimit.keyed (keyed bounded bucket map)", () => {
  // admits: the map export missing from the core subpath yak imports
  it("is the core subpath's makeKeyedBuckets", () => {
    expect(HeraRateLimit.keyed).toBe(fromCore)
  })

  // admits: a fresh key starting empty, or one key's spend draining another's bucket
  it("a never-held key is full, and each key spends its own bucket", () => {
    const map = HeraRateLimit.keyed(LIMIT, { maxKeys: 4 })
    expect(map.read("a", T0)).toEqual({ kind: "bucket", bucket: { tokens: 10, updatedAt: T0 } })
    expect(map.spend("a", T0, 10)).toBeNull()
    expect(map.spend("a", T0)).toEqual({ reason: "key", waitMs: 500 })
    expect(map.spend("b", T0, 10)).toBeNull()
    expect(map.size()).toBe(2)
  })

  // admits: a backwards clock minting tokens for a key
  it("a skewed clock earlier than the stamp adds nothing", () => {
    const map = HeraRateLimit.keyed(LIMIT, { maxKeys: 4 })
    expect(map.spend("a", T0, 10)).toBeNull()
    expect(map.read("a", T0 - 60_000)).toEqual({
      kind: "bucket",
      bucket: { tokens: 0, updatedAt: T0 },
    })
  })

  // admits: an off-by-one wait (caller retries early), or a refusal that still takes tokens
  it("whole-token waits round up, a refusal takes nothing, and the wait admits", () => {
    const map = HeraRateLimit.keyed(LIMIT, { maxKeys: 4 })
    expect(map.spend("a", T0, 9)).toBeNull()
    expect(map.spend("a", T0, 3)).toEqual({ reason: "key", waitMs: 1000 })
    expect(map.spend("a", T0, 1)).toBeNull() // the refused spend of 3 took nothing
    expect(map.spend("a", T0 + 1499, 3)).toEqual({ reason: "key", waitMs: 1 })
    expect(map.spend("a", T0 + 1500, 3)).toBeNull()
  })

  // admits: the map growing past its cap under a flood of new keys
  it("never holds more than maxKeys keys; a held key is never refused for room", () => {
    const map = HeraRateLimit.keyed(LIMIT, { maxKeys: 3 })
    for (const key of ["a", "b", "c"]) expect(map.spend(key, T0)).toBeNull()
    for (let i = 0; i < 50; i++) {
      expect(map.spend(`flood-${i}`, T0)).toEqual({ reason: "full", waitMs: 500 })
    }
    expect(map.size()).toBe(3)
    expect(map.spend("a", T0)).toBeNull()
    expect(() => map.write("d", { tokens: 10, updatedAt: T0 })).toThrow(RangeError)
    expect(map.size()).toBe(3)
  })

  // admits: reclaiming a bucket that still owes tokens, which would hand that key a fresh burst
  it("reclaims only buckets refilled to capacity", () => {
    const map = HeraRateLimit.keyed(LIMIT, { maxKeys: 2 })
    expect(map.spend("full-soon", T0, 1)).toBeNull() // full again at T0 + 500
    expect(map.spend("drained", T0, 10)).toBeNull() // full again at T0 + 5000
    expect(map.spend("new", T0 + 500)).toBeNull()
    expect(map.size()).toBe(2)
    expect(map.read("drained", T0 + 500)).toEqual({
      kind: "bucket",
      bucket: { tokens: 1, updatedAt: T0 + 500 },
    })
  })

  // admits: a `full` wait that is too short (the retry is refused again) or unbounded
  it("a full wait is the time until the soonest bucket refills, and admits after it", () => {
    const map = HeraRateLimit.keyed(LIMIT, { maxKeys: 2 })
    expect(map.spend("a", T0, 10)).toBeNull()
    expect(map.spend("b", T0, 4)).toBeNull()
    map.write("b", map.take({ tokens: 6, updatedAt: T0 }, 8)) // debt: -2, full in 6000 ms
    expect(map.read("c", T0)).toEqual({ kind: "full", waitMs: 5000 })
    expect(map.spend("c", T0 + 4000)).toEqual({ reason: "full", waitMs: 1000 })
    expect(map.spend("c", T0 + 4999)?.reason).toBe("full")
    expect(map.spend("c", T0 + 5000)).toBeNull()
    expect(map.read("b", T0 + 5000)).toEqual({
      kind: "bucket",
      bucket: { tokens: 8, updatedAt: T0 + 5000 },
    })
  })

  // admits: a read/write pair breaching the cap when another key lands between them (k-step)
  it("a write after another key filled the cap throws rather than exceed it", () => {
    const map = HeraRateLimit.keyed(LIMIT, { maxKeys: 1 })
    const read = map.read("a", T0)
    expect(read.kind).toBe("bucket")
    expect(map.spend("b", T0)).toBeNull()
    if (read.kind !== "bucket") return
    expect(() => map.write("a", map.take(read.bucket))).toThrow(RangeError)
    expect(map.size()).toBe(1)
  })

  // admits: a cap of zero/NaN (no key ever admitted) or an unpayable spend looping forever
  it("rejects an invalid maxKeys, limit or spend", () => {
    for (const maxKeys of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => HeraRateLimit.keyed(LIMIT, { maxKeys })).toThrow(RangeError)
    }
    expect(() => HeraRateLimit.keyed({ capacity: 0, refillPerSecond: 1 }, { maxKeys: 1 })).toThrow(
      RangeError
    )
    const map = HeraRateLimit.keyed(LIMIT, { maxKeys: 1 })
    expect(() => map.spend("a", T0, 11)).toThrow(RangeError)
    expect(() => map.spend("a", T0, 0)).toThrow(RangeError)
    expect(map.size()).toBe(0)
  })
})
