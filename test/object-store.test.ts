import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import { HeraError } from "../src/index"
import { HeraObjectStore, type HeraObjectStoreClient } from "../src/core/object-store/index"
import { HeraTest } from "../src/testing/index"
import { makeS3Double } from "./object-store-s3-double"

const credentials = {
  accessKeyId: Redacted.make("test-access-key-id"),
  secretAccessKey: Redacted.make("test-secret-access-key"),
}

const failure = <A>(effect: Effect.Effect<A, HeraError>) =>
  HeraTest.runTest(Effect.flip(effect))

const run = <A>(effect: Effect.Effect<A, HeraError>) => HeraTest.runTest(effect)

const IMPLEMENTATIONS: ReadonlyArray<readonly [string, () => HeraObjectStoreClient]> = [
  ["HeraTest.objectStore (fake)", () => HeraTest.objectStore()],
  [
    "HeraObjectStore.r2S3 over the S3 double",
    () => {
      const double = makeS3Double("scratch")
      return HeraObjectStore.r2S3({
        accountId: "acct",
        bucket: "scratch",
        credentials,
        fetch: double.fetch,
      })
    },
  ],
]

// admits: the fake and the S3 transport drifting apart on precondition and metadata semantics; two implementations of one behaviour no type relates
describe.each(IMPLEMENTATIONS)("HeraObjectStore contract: %s", (_name, make) => {
  // admits: create-once not enforced, or refused as a generic error instead of precondition_failed; runtime store state
  it("ifNoneMatch '*' creates once; a second create fails precondition_failed (412)", async () => {
    const store = make()
    const created = await run(store.put("index.json", "{}", { ifNoneMatch: "*" }))
    expect(created.etag).toMatch(/^[^"]+$/)
    const err = await failure(store.put("index.json", "{}", { ifNoneMatch: "*" }))
    expect(HeraError.is(err)).toBe(true)
    expect(err.code).toBe("precondition_failed")
    expect(err.httpStatus).toBe(412)
  })

  // admits: a stale etag overwriting a newer write (lost update); runtime store state
  it("a stale ifMatch fails precondition_failed; the current one writes a new etag", async () => {
    const store = make()
    const v1 = await run(store.put("k", "one"))
    const v2 = await run(store.put("k", "two", { ifMatch: v1.etag }))
    expect(v2.etag).not.toBe(v1.etag)
    const err = await failure(store.put("k", "three", { ifMatch: v1.etag }))
    expect(err.code).toBe("precondition_failed")
    const got = await run(store.get("k"))
    expect(got._tag === "Found" && new TextDecoder().decode(got.body)).toBe("two")
  })

  // admits: ifMatch on an absent key creating it; runtime store state
  it("ifMatch on a missing key fails precondition_failed", async () => {
    const err = await failure(make().put("absent", "x", { ifMatch: "abc" }))
    expect(err.code).toBe("precondition_failed")
  })

  // admits: metadata lost or renamed between put and get/head/list; header mapping is runtime
  it("customMetadata and contentType round-trip on get, head and list(include)", async () => {
    const store = make()
    const meta = { sha: "9f2c", "bundle-version": "v2 beta" }
    const put = await run(store.put("bundles/a.tgz", new Uint8Array([1, 2, 3]), {
      customMetadata: meta,
      contentType: "application/gzip",
    }))
    const got = await run(store.get("bundles/a.tgz"))
    expect(got._tag).toBe("Found")
    if (got._tag !== "Found") return
    expect(got.object.customMetadata).toEqual(meta)
    expect(got.object.contentType).toBe("application/gzip")
    expect(got.object.etag).toBe(put.etag)
    expect([...got.body]).toEqual([1, 2, 3])
    const head = await run(store.head("bundles/a.tgz"))
    expect(head._tag === "Found" && head.object.customMetadata).toEqual(meta)
    expect(head._tag === "Found" && head.object.size).toBe(3)
    const listed = await run(store.list({ prefix: "bundles/", include: ["customMetadata"] }))
    expect(listed.objects).toHaveLength(1)
    expect(listed.objects[0]).toMatchObject({ key: "bundles/a.tgz", etag: put.etag, size: 3, customMetadata: meta })
    expect(listed.objects[0]).not.toHaveProperty("contentType")
    const bare = await run(store.list({ prefix: "bundles/" }))
    expect(bare.objects[0]?.customMetadata).toBeUndefined()
  })

  // admits: 304/404 surfacing as errors instead of results; status mapping is runtime
  it("get answers NotFound for a missing key and NotModified for the current etag", async () => {
    const store = make()
    expect(await run(store.get("nope"))).toEqual({ _tag: "NotFound" })
    expect(await run(store.head("nope"))).toEqual({ _tag: "NotFound" })
    const put = await run(store.put("k", "v"))
    expect(await run(store.get("k", { ifNoneMatch: put.etag }))).toEqual({ _tag: "NotModified" })
    expect((await run(store.get("k", { ifNoneMatch: "other" })))._tag).toBe("Found")
    expect(await run(store.get("k", { ifNoneMatch: "*" }))).toEqual({ _tag: "NotModified" })
  })

  // admits: pagination skipping or repeating keys; runtime ordering
  it("lists lexicographically by prefix and pages with cursor", async () => {
    const store = make()
    for (const k of ["p/c", "p/a", "q/x", "p/b"]) await run(store.put(k, k))
    const first = await run(store.list({ prefix: "p/", limit: 2 }))
    expect(first.objects.map((o) => o.key)).toEqual(["p/a", "p/b"])
    expect(first.truncated).toBe(true)
    const second = await run(store.list({ prefix: "p/", limit: 2, cursor: first.cursor }))
    expect(second.objects.map((o) => o.key)).toEqual(["p/c"])
    expect(second.truncated).toBe(false)
  })

  // admits: metadata the S3 path would mangle accepted in one store but not the other; value checks are runtime
  it("refuses metadata that would not round-trip, and a bad limit, with invalid_request", async () => {
    const store = make()
    for (const customMetadata of [{ Sha: "x" }, { sha: "é" }, { sha: " padded" }, { sha: "a  b" }, { "": "x" }]) {
      const err = await failure(store.put("k", "v", { customMetadata }))
      expect(err.code).toBe("invalid_request")
    }
    for (const key of ["", "../other/x", "a/./b", "a/..", "."]) {
      expect((await failure(store.put(key, "v"))).code).toBe("invalid_request")
    }
    expect((await failure(store.list({ limit: 0 }))).code).toBe("invalid_request")
    expect(await run(store.head("k"))).toEqual({ _tag: "NotFound" })
  })

  // admits: a yield between precondition check and commit letting two creates win; fiber interleaving is runtime
  it("of two concurrent ifNoneMatch '*' creates, exactly one wins", async () => {
    const store = make()
    const results = await run(
      Effect.all(
        [store.put("lock", "a", { ifNoneMatch: "*" }), store.put("lock", "b", { ifNoneMatch: "*" })].map(
          (e) => Effect.result(e)
        ),
        { concurrency: 2 }
      )
    )
    expect(results.filter((r) => r._tag === "Success")).toHaveLength(1)
  })
})
