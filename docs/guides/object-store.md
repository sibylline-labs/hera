# Object Store (`HeraObjectStore`, `@sibylline-labs/hera/object-store`)

`HeraObjectStore` (`src/core/object-store/`) reads and writes objects with etags, conditional writes and custom metadata. It is runtime-agnostic (WebCrypto and `fetch` only), so a bun CLI such as eris and a Worker can both use it. `HeraTest.objectStore()` is the in-memory fake with the same semantics, so a consumer's tests never touch a real bucket.

| Member | What it is |
|---|---|
| `HeraObjectStore.r2S3(config)` | R2 over its S3-compatible endpoint, SigV4-signed, over `HeraHttp.requestBytes` |
| `HeraObjectStore.credentialsFromApiToken({ apiToken, accountId? })` | Derives the S3 key pair from a Cloudflare API token |
| `HeraTest.objectStore()` (`@sibylline-labs/hera/testing`) | In-memory fake, plus `snapshot()` for assertions |

Every store is a `HeraObjectStoreClient`: `get`, `put`, `head` and `list`. Their result types mirror a Worker `R2Object` / `R2Objects` (`etag` unquoted, `customMetadata`, `truncated`, `cursor`), so an `R2Bucket` binding fits behind the same interface.

---

## 1. Why the S3 endpoint

R2 has two HTTP object APIs. Only the S3-compatible one carries what optimistic concurrency needs on a write:

| Need | Cloudflare REST object API | S3-compatible endpoint |
|---|---|---|
| `If-Match` / `If-None-Match: *` on put | not documented | yes, evaluated atomically with the commit (`412` on failure) |
| custom metadata on put, get, head | not documented | yes, `x-amz-meta-*` (the binding's `customMetadata`) |
| custom metadata in list | yes | no: `list({ include: ["customMetadata"] })` HEADs each key |
| bucket-scoped tokens | no | yes |

## 2. Using it

```ts
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { HeraObjectStore } from "@sibylline-labs/hera/object-store"

const publish = (apiToken: string, accountId: string, bundle: Uint8Array, seenEtag: string) =>
  Effect.gen(function* () {
    const credentials = yield* HeraObjectStore.credentialsFromApiToken({
      apiToken: Redacted.make(apiToken),
      accountId,
    })
    const store = HeraObjectStore.r2S3({ accountId, bucket: "shared-state", credentials })

    // Create once: a second create fails `precondition_failed`.
    yield* store.put("bundles/v1.tgz", bundle, {
      ifNoneMatch: "*",
      customMetadata: { sha: "9f2c" },
      contentType: "application/gzip",
    })

    // Optimistic update: fails `precondition_failed` if someone wrote since `seenEtag`.
    const written = yield* store.put("index.json", "{}", { ifMatch: seenEtag })

    const current = yield* store.get("index.json", { ifNoneMatch: written.etag })
    // current._tag: "Found" | "NotFound" | "NotModified"
    return yield* store.list({ prefix: "bundles/", include: ["customMetadata"] })
  })
```

- `get` returns `{ _tag: "Found", object, body }`, `{ _tag: "NotFound" }`, or `{ _tag: "NotModified" }` when `ifNoneMatch` names the current etag (or is `"*"`). `head` returns `Found` or `NotFound`.
- `put` returns the stored object with its new `etag`. `uploaded` is the client's `Clock` time (S3 `PutObject` returns no `Last-Modified`).
- `list` is one page: `limit` 1–1000 (default 1000), `cursor` from the previous page while `truncated`. List items carry `key`, `etag`, `size`, `uploaded` and, with `include: ["customMetadata"]`, `customMetadata`. With `include` it HEADs each key (at most 8 at once); each item's etag and metadata come from the same HEAD, and a key deleted between the list and its HEAD is left out. The page is not a snapshot.
- `r2S3` config: `accountId`, `bucket`, `credentials`; optional `endpoint` (default `https://<accountId>.r2.cloudflarestorage.com`, override for a jurisdictional bucket), `timeoutMs`, `maxBytes` (largest `get` body, default 32 MiB), `fetch`. Redirects are never followed.

## 3. Credentials

`credentialsFromApiToken` follows R2's documented derivation: the access key id is the token's id, read from `GET /user/tokens/verify` (then `/accounts/<accountId>/tokens/verify` for an account-owned token), and the secret access key is the SHA-256 hex of the token value. Both come back `Redacted`. You can also pass an R2 key pair (`{ accessKeyId, secretAccessKey }`, both `Redacted`) straight to `r2S3`. Neither half leaves `Redacted` except inside the SigV4 signer.

## 4. Errors

Every failure is a closed `HeraError` ([ERRORS.md](../ERRORS.md)):

| Upstream | `HeraError` code | Status |
|---|---|---|
| a failed `ifMatch` / `ifNoneMatch: "*"` (`412`, or `404` on a put carrying `ifMatch`) | `precondition_failed` | 412 |
| `429` | `rate_limited`, with `retryAfter` | 429 |
| a bad key, metadata entry or `limit` (refused before any request) | `invalid_request` | 400 |
| anything else: timeout, network, `401`/`403`, `5xx`, a 3xx, an unreadable reply, a `get` or `list` on a missing bucket (`NoSuchBucket`) | `upstream_error` | 502 |

`fields` carry only `op`, `object` (the key, on `precondition_failed`), `status`, `upstream` (the `HeraHttpError` reason) and `s3Code` (the S3 `<Code>`, e.g. `AccessDenied`, `NoSuchBucket`); never a response body, URL or header value.

## 5. Keys and custom metadata

A key is 1–1024 UTF-8 bytes with no `.` or `..` segment: URL parsing collapses dot segments (even percent-encoded), so `../other/x` would address another bucket.

Metadata keys match `^[a-z0-9][a-z0-9_-]{0,127}$`; values are printable ASCII words separated by single spaces. HTTP lowercases header names and trims edge whitespace, SigV4 collapses inner runs of spaces, and R2 RFC-2047-encodes non-ASCII values on the S3 path, while a Worker binding keeps all of these as written, so only this subset reads back identically on both paths. Every store, the fake included, refuses anything else with `invalid_request`.

A `get` on a missing bucket fails `NoSuchBucket`; a `head` cannot tell (a HEAD reply has no body), so it answers `NotFound`.

## 6. Testing

```ts
import * as Effect from "effect/Effect"
import { HeraTest } from "@sibylline-labs/hera/testing"

const store = HeraTest.objectStore()
const program = Effect.gen(function* () {
  const first = yield* store.put("index.json", "{}", { ifNoneMatch: "*" })
  const again = yield* Effect.flip(store.put("index.json", "{}", { ifNoneMatch: "*" }))
  return [first.etag, again.code] // [<etag>, "precondition_failed"]
})
await HeraTest.runTest(program)
store.snapshot().get("index.json")?.text // "{}"
```

The fake checks a precondition and commits in one synchronous step, so of two racing `ifNoneMatch: "*"` creates exactly one wins. `test/object-store.test.ts` runs one contract suite against the fake and against `r2S3` over an S3-emulating `fetch` double, so the two cannot drift apart.

## 7. Live probe

`test/live/object-store-r2.probe.ts` exercises a real bucket: token-derived credentials, create-once, stale `ifMatch`, metadata round-trip on get/head/list, and `NotModified`. It runs only with `HERA_R2_PROBE_BUCKET` set and writes only under `hera-probe/<run id>/`:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… HERA_R2_PROBE_BUCKET=<scratch bucket> \
  bun test/live/object-store-r2.probe.ts
```
