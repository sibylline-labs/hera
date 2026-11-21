import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import type { HeraError } from "../src/index"
import { HeraObjectStore } from "../src/core/object-store/index"
import { HeraTest } from "../src/testing/index"
import { makeS3Double } from "./object-store-s3-double"

const credentials = {
  accessKeyId: Redacted.make("test-access-key-id"),
  secretAccessKey: Redacted.make("test-secret-access-key"),
}

function setup() {
  const double = makeS3Double("scratch")
  const store = HeraObjectStore.r2S3({ accountId: "acct", bucket: "scratch", credentials, fetch: double.fetch })
  return { double, store }
}

const run = <A>(effect: Effect.Effect<A, HeraError>) => HeraTest.runTest(effect)
const failure = <A>(effect: Effect.Effect<A, HeraError>) => HeraTest.runTest(Effect.flip(effect))

describe("HeraObjectStore.r2S3 wire behaviour", () => {
  // admits: conditional and metadata headers missing or unquoted on the wire; header strings are runtime data
  it("sends quoted If-Match, If-None-Match '*', x-amz-meta-* and content-type, signed, path-style", async () => {
    const { double, store } = setup()
    const v1 = await run(store.put("a b/ü.json", "x", { ifNoneMatch: "*", customMetadata: { sha: "1" }, contentType: "application/json" }))
    await run(store.put("a b/ü.json", "y", { ifMatch: v1.etag }))
    const [create, update] = double.requests
    expect(create?.url).toBe("https://acct.r2.cloudflarestorage.com/scratch/a%20b/%C3%BC.json")
    expect(create?.headers).toMatchObject({
      "if-none-match": "*",
      "x-amz-meta-sha": "1",
      "content-type": "application/json",
    })
    expect(create?.headers.authorization).toContain(
      "SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-sha"
    )
    expect(update?.headers["if-match"]).toBe(`"${v1.etag}"`)
  })

  // admits: an upstream error body or credential reaching the HeraError; the body is runtime text
  it("maps 403 AccessDenied to upstream_error carrying the S3 code, never the body", async () => {
    const { double, store } = setup()
    double.failNext(403, "<Error><Code>AccessDenied</Code><Message>leaky detail test-access-key-id</Message></Error>")
    const err = await failure(store.get("k"))
    expect(err.code).toBe("upstream_error")
    expect(err.httpStatus).toBe(502)
    expect(err.fields).toEqual({ op: "get", upstream: "HttpStatusError", status: 403, s3Code: "AccessDenied" })
    expect(JSON.stringify(err.toProblemDetails())).not.toContain("leaky")
    expect(err.cause).toBeUndefined()
  })

  // admits: a 429 surfacing as a generic upstream failure without its retry hint; status mapping is runtime
  it("maps 429 to rate_limited with retryAfter", async () => {
    const { double, store } = setup()
    double.failNext(429, "", { "retry-after": "7" })
    const err = await failure(store.put("k", "v"))
    expect(err.code).toBe("rate_limited")
    expect(err.retryAfter).toBe(7)
  })

  // admits: a redirect followed with signed headers, or a 3xx read as success; fetch redirect handling is runtime
  it("treats a 3xx as upstream_error and does not follow it", async () => {
    const { double, store } = setup()
    double.failNext(307, "", { location: "https://elsewhere.example/x" })
    const err = await failure(store.head("k"))
    expect(err.code).toBe("upstream_error")
    expect(double.requests).toHaveLength(1)
  })

  // admits: list with include dropping metadata or keeping a key deleted between list and HEAD; a race on runtime state
  it("list include HEADs each key, dropping a key deleted before its HEAD", async () => {
    const { double, store } = setup()
    await run(store.put("p/a", "1", { customMetadata: { n: "a" } }))
    await run(store.put("p/b", "2", { customMetadata: { n: "b" } }))
    const realFetch = double.fetch
    let listed = false
    const racing = HeraObjectStore.r2S3({
      accountId: "acct",
      bucket: "scratch",
      credentials,
      fetch: async (input, init) => {
        const res = await realFetch(input, init)
        if (!listed && String(input).includes("list-type=2")) {
          listed = true
          double.remove("p/a")
        }
        return res
      },
    })
    const out = await run(racing.list({ prefix: "p/", include: ["customMetadata"] }))
    expect(out.objects.map((o) => [o.key, o.customMetadata])).toEqual([["p/b", { n: "b" }]])
  })

  // admits: HEAD's content-length (the object size) refused by the response byte ceiling; runtime sizes
  it("heads and lists(include) an object larger than the 64 KiB response ceiling", async () => {
    const { store } = setup()
    await run(store.put("big", new Uint8Array(200 * 1024)))
    const head = await run(store.head("big"))
    expect(head._tag === "Found" && head.object.size).toBe(200 * 1024)
    const listed = await run(store.list({ include: ["customMetadata"] }))
    expect(listed.objects[0]?.size).toBe(200 * 1024)
  })

  // admits: a misconfigured bucket read as an empty one (get → NotFound); the 404 body is runtime
  it("maps a GET 404 NoSuchBucket to upstream_error, not NotFound", async () => {
    const double = makeS3Double("scratch")
    const store = HeraObjectStore.r2S3({ accountId: "acct", bucket: "typo", credentials, fetch: double.fetch })
    const err = await failure(store.get("k"))
    expect(err.fields).toMatchObject({ op: "get", status: 404, s3Code: "NoSuchBucket" })
    expect((await failure(store.list())).fields).toMatchObject({ op: "list", status: 404 })
  })

  // admits: an upstream answering 404 NoSuchKey (AWS's documented reply) to If-Match on a missing key read as upstream_error; runtime status
  it("maps a 404 on a PUT carrying If-Match to precondition_failed", async () => {
    const { double, store } = setup()
    double.failNext(404, "<Error><Code>NoSuchKey</Code></Error>")
    const err = await failure(store.put("absent", "x", { ifMatch: "abc" }))
    expect(err.code).toBe("precondition_failed")
  })

  // admits: a weak etag double-quoted into an If-Match no server matches; header strings are runtime
  it("passes a weak etag through unchanged", async () => {
    const { double, store } = setup()
    await failure(store.put("k", "v", { ifMatch: 'W/"abc"' }))
    expect(double.requests.at(-1)?.headers["if-match"]).toBe('W/"abc"')
  })

  // admits: a non-XML list reply read as an empty bucket; the body shape is runtime
  it("fails upstream_error DecodeError on a list reply that is not a ListBucketResult", async () => {
    const { double, store } = setup()
    double.failNext(200, "<html>captive portal</html>")
    const err = await failure(store.list())
    expect(err.fields).toMatchObject({ op: "list", upstream: "DecodeError" })
  })
})
