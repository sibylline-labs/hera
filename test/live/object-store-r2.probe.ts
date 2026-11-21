/**
 * Live probe of `HeraObjectStore.r2S3` against a real R2 bucket: the premises the
 * unit tests take from R2's docs. Not a vitest file; run by hand against a scratch bucket only:
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… HERA_R2_PROBE_BUCKET=<scratch> \
 *     bun test/live/object-store-r2.probe.ts
 *
 * Writes only under `hera-probe/<run id>/` and leaves those objects behind (the store has no
 * delete); drop the scratch bucket afterwards. Prints one line per step, exits 1 on any failure.
 */
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { HeraObjectStore } from "../../src/core/object-store/index"

const bucket = process.env.HERA_R2_PROBE_BUCKET
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
if (!bucket || !accountId || !apiToken) {
  console.error("set HERA_R2_PROBE_BUCKET, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN")
  process.exit(2)
}

const prefix = `hera-probe/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}/`
let failed = 0
const step = (name: string, ok: boolean, detail: unknown = "") => {
  if (!ok) failed += 1
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  ${JSON.stringify(detail)}`}`)
}

const probe = Effect.gen(function* () {
  const credentials = yield* HeraObjectStore.credentialsFromApiToken({
    apiToken: Redacted.make(apiToken),
    accountId,
  })
  step("1 credentials derived from CLOUDFLARE_API_TOKEN", true)
  const store = HeraObjectStore.r2S3({ accountId, bucket, credentials })
  const key = `${prefix}index.json`
  const meta = { sha: "9f2c", "bundle-version": "v2 beta" }

  const v1 = yield* store.put(key, '{"v":1}', { ifNoneMatch: "*", customMetadata: meta, contentType: "application/json" })
  step("2 put ifNoneMatch '*' creates", v1.etag.length > 0, { etag: v1.etag })

  const again = yield* Effect.flip(store.put(key, '{"v":1}', { ifNoneMatch: "*" }))
  step("3 put ifNoneMatch '*' on an existing key fails precondition_failed", again.code === "precondition_failed", again.code)

  const stale = yield* Effect.flip(store.put(key, '{"v":2}', { ifMatch: "00000000000000000000000000000000" }))
  step("4a put with a stale ifMatch fails precondition_failed", stale.code === "precondition_failed", stale.code)
  const v2 = yield* store.put(key, '{"v":2}', { ifMatch: v1.etag, customMetadata: meta })
  step("4b put with the current ifMatch writes a new etag", v2.etag !== v1.etag, { etag: v2.etag })

  const got = yield* store.get(key)
  step("5a get returns body + customMetadata", got._tag === "Found" && JSON.stringify(got.object.customMetadata) === JSON.stringify(meta) && new TextDecoder().decode(got.body) === '{"v":2}', got._tag === "Found" ? got.object : got)
  const head = yield* store.head(key)
  step("5b head returns customMetadata + etag", head._tag === "Found" && head.object.etag === v2.etag && head.object.customMetadata.sha === "9f2c", head._tag === "Found" ? head.object : head)

  const listed = yield* store.list({ prefix, include: ["customMetadata"] })
  step("6 list(include) returns etag + customMetadata", listed.objects.length === 1 && listed.objects[0]?.etag === v2.etag && listed.objects[0]?.customMetadata?.sha === "9f2c", listed)

  const notModified = yield* store.get(key, { ifNoneMatch: v2.etag })
  step("7 get ifNoneMatch current etag is NotModified", notModified._tag === "NotModified", notModified._tag)
  const missing = yield* store.get(`${prefix}absent`)
  step("8 get missing key is NotFound", missing._tag === "NotFound", missing._tag)
  const absentMatch = yield* Effect.flip(store.put(`${prefix}absent`, "x", { ifMatch: v2.etag }))
  step("9 put ifMatch on a missing key fails precondition_failed", absentMatch.code === "precondition_failed", absentMatch.fields)
})

await Effect.runPromise(
  probe.pipe(Effect.catch((err) => Effect.sync(() => step("probe aborted", false, err))))
)
console.log(`prefix ${prefix} in bucket ${bucket}; ${failed === 0 ? "all steps passed" : `${failed} step(s) failed`}`)
process.exit(failed === 0 ? 0 : 1)
