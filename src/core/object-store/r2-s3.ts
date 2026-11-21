import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type { HeraError } from "../errors/index.js"
import { fn } from "../fn/index.js"
import {
  type HeraHttpBytesResponse,
  HeraHttpError,
  type HttpMethod,
  type RateLimitedError,
  requestBytes,
} from "../http/index.js"
import { preconditionFailed, toStoreError, upstreamError } from "./errors.js"
import {
  checkCustomMetadata,
  checkObjectKey,
  encodeKeyPath,
  encodeRfc3986,
  invalidRequest,
  metadataHeaders,
  quoteEtag,
  readMetadata,
  unquoteEtag,
} from "./metadata.js"
import { parseListObjectsV2, parseS3ErrorCode } from "./s3-xml.js"
import { type HeraS3Credentials, sha256Hex, signSigV4 } from "./sigv4.js"
import type {
  HeraObjectHeadResult,
  HeraObjectListItem,
  HeraObjectStoreClient,
  HeraObjectStoreOp,
  HeraStoredObject,
} from "./types.js"

export interface HeraR2S3Config {
  readonly accountId: string
  readonly bucket: string
  readonly credentials: HeraS3Credentials
  /** Default `https://<accountId>.r2.cloudflarestorage.com` (a jurisdictional bucket overrides it). */
  readonly endpoint?: string | undefined
  readonly timeoutMs?: number | undefined
  /** Largest `get` body read, bytes (default 32 MiB); a larger object fails `upstream_error`. */
  readonly maxBytes?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}

export const DEFAULT_OBJECT_MAX_BYTES = 32 * 1024 * 1024
const LIST_MAX_BYTES = 4 * 1024 * 1024
const HEAD_CONCURRENCY = 8

type Exchanged =
  | { readonly _tag: "Response"; readonly res: HeraHttpBytesResponse }
  | { readonly _tag: "Status"; readonly status: 304 | 404 }

const answered = (status: 304 | 404): Exchanged => ({ _tag: "Status", status })
const responded = (res: HeraHttpBytesResponse): Exchanged => ({ _tag: "Response", res })
const notFound: HeraObjectHeadResult = { _tag: "NotFound" }

function toObject(key: string, headers: Headers, size: number, nowMs: number): HeraStoredObject {
  const modified = Date.parse(headers.get("last-modified") ?? "")
  const contentType = headers.get("content-type")
  return {
    key,
    etag: unquoteEtag(headers.get("etag") ?? ""),
    size,
    uploaded: Number.isFinite(modified) ? modified : nowMs,
    ...(contentType !== null ? { contentType } : {}),
    customMetadata: readMetadata(headers),
  }
}

/**
 * `HeraObjectStoreClient` over R2's S3-compatible endpoint: the only R2 transport that
 * carries `If-Match` / `If-None-Match` and custom metadata on a write. Requests are SigV4-signed
 * (region `auto`) over `HeraHttp.requestBytes`; redirects are never followed.
 */
export function r2S3(config: HeraR2S3Config): HeraObjectStoreClient {
  const endpoint = (
    config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`
  ).replace(/\/+$/, "")
  const bucketUrl = `${endpoint}/${encodeRfc3986(config.bucket)}`
  const objectUrl = (key: string) => `${bucketUrl}/${encodeKeyPath(key)}`

  const send = fn("HeraObjectStore.r2S3.send")(function* (
    op: HeraObjectStoreOp,
    key: string,
    request: {
      readonly method: HttpMethod
      readonly url: string
      readonly headers?: Readonly<Record<string, string>>
      readonly body?: Uint8Array
      readonly maxBytes?: number
      /** HEAD: `content-length` is the object's size, not a body to bound. */
      readonly headOnly?: boolean
    }
  ) {
    const nowMs = yield* Clock.currentTimeMillis
    const headers = yield* Effect.promise(async () =>
      signSigV4({
        method: request.method,
        url: request.url,
        headers: request.headers ?? {},
        payloadSha256: await sha256Hex(request.body ?? ""),
        credentials: config.credentials,
        region: "auto",
        service: "s3",
        nowMs,
      })
    )
    const result = yield* Effect.result(
      requestBytes({
        url: request.url,
        method: request.method,
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        timeoutMs: config.timeoutMs,
        maxBytes: request.maxBytes,
        ...(request.headOnly === true ? { onMaxBytes: "truncate" as const } : {}),
        fetch: config.fetch,
        redirect: "manual",
      })
    )
    if (result._tag === "Failure") {
      const err: HeraHttpError | RateLimitedError = result.failure
      if (HeraHttpError.is(err) && err.status === 404 && parseS3ErrorCode(err.body) === "NoSuchBucket") {
        return yield* Effect.fail(
          upstreamError(op, { status: 404, upstream: err.reason, s3Code: "NoSuchBucket" })
        )
      }
      if (HeraHttpError.is(err) && err.status === 404 && request.headers?.["if-match"] !== undefined) {
        return yield* Effect.fail(preconditionFailed(op, key))
      }
      if (HeraHttpError.is(err) && (err.status === 404 || err.status === 304)) {
        return answered(err.status)
      }
      return yield* Effect.fail(toStoreError(op, key, err))
    }
    const res = result.success
    if (res.status === 304) {
      return answered(304)
    }
    if (res.status >= 300) {
      return yield* Effect.fail(
        upstreamError(op, { status: res.status, upstream: "HttpStatusError" })
      )
    }
    return responded(res)
  })

  const refuse = (error: HeraError | null) =>
    error === null ? Effect.void : Effect.fail(error)

  const head = fn("HeraObjectStore.head")(function* (key: string) {
    yield* refuse(checkObjectKey("head", key))
    const out = yield* send("head", key, { method: "HEAD", url: objectUrl(key), headOnly: true })
    if (out._tag === "Status") {
      return notFound
    }
    const nowMs = yield* Clock.currentTimeMillis
    const size = Number(out.res.headers.get("content-length") ?? "0")
    const found: HeraObjectHeadResult = {
      _tag: "Found",
      object: toObject(key, out.res.headers, size, nowMs),
    }
    return found
  })

  return {
    head,
    get: fn("HeraObjectStore.get")(function* (key: string, options = {}) {
      yield* refuse(checkObjectKey("get", key))
      const out = yield* send("get", key, {
        method: "GET",
        url: objectUrl(key),
        ...(options.ifNoneMatch !== undefined
          ? { headers: { "if-none-match": quoteEtag(options.ifNoneMatch) } }
          : {}),
        maxBytes: config.maxBytes ?? DEFAULT_OBJECT_MAX_BYTES,
      })
      if (out._tag === "Status") {
        return out.status === 304
          ? ({ _tag: "NotModified" } as const)
          : ({ _tag: "NotFound" } as const)
      }
      const nowMs = yield* Clock.currentTimeMillis
      return {
        _tag: "Found",
        object: toObject(key, out.res.headers, out.res.bytes.byteLength, nowMs),
        body: out.res.bytes,
      } as const
    }),
    put: fn("HeraObjectStore.put")(function* (key: string, body, options = {}) {
      yield* refuse(checkObjectKey("put", key))
      yield* refuse(checkCustomMetadata("put", options.customMetadata))
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
      const headers: Record<string, string> = {
        ...metadataHeaders(options.customMetadata),
        ...(options.contentType !== undefined ? { "content-type": options.contentType } : {}),
        ...(options.ifMatch !== undefined ? { "if-match": quoteEtag(options.ifMatch) } : {}),
        ...(options.ifNoneMatch !== undefined ? { "if-none-match": options.ifNoneMatch } : {}),
      }
      const out = yield* send("put", key, { method: "PUT", url: objectUrl(key), headers, body: bytes })
      if (out._tag === "Status") {
        return yield* Effect.fail(
          upstreamError("put", { status: out.status, upstream: "HttpStatusError" })
        )
      }
      const etag = out.res.headers.get("etag")
      if (etag === null) {
        return yield* Effect.fail(upstreamError("put", { status: out.res.status, upstream: "DecodeError" }))
      }
      const uploaded = yield* Clock.currentTimeMillis
      return {
        key,
        etag: unquoteEtag(etag),
        size: bytes.byteLength,
        uploaded,
        ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
        customMetadata: { ...options.customMetadata },
      }
    }),
    list: fn("HeraObjectStore.list")(function* (options = {}) {
      const limit = options.limit ?? 1000
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return yield* Effect.fail(invalidRequest("list", "limit"))
      }
      const query = new URLSearchParams({ "list-type": "2", "max-keys": String(limit) })
      if (options.prefix !== undefined) query.set("prefix", options.prefix)
      if (options.cursor !== undefined) query.set("continuation-token", options.cursor)
      const url = `${bucketUrl}?${query.toString().replace(/\+/g, "%20")}`
      const out = yield* send("list", "", { method: "GET", url, maxBytes: LIST_MAX_BYTES })
      if (out._tag === "Status") {
        return yield* Effect.fail(upstreamError("list", { status: out.status, upstream: "HttpStatusError" }))
      }
      const page = parseListObjectsV2(new TextDecoder().decode(out.res.bytes))
      if (page === null) {
        return yield* Effect.fail(upstreamError("list", { upstream: "DecodeError" }))
      }
      const objects: ReadonlyArray<HeraObjectListItem> = options.include?.includes("customMetadata")
        ? (yield* Effect.forEach(page.contents, (item) => head(item.key), {
            concurrency: HEAD_CONCURRENCY,
          })).flatMap((r) => {
            if (r._tag !== "Found") return []
            const { contentType: _contentType, ...item } = r.object
            return [item]
          })
        : page.contents
      return {
        objects,
        truncated: page.truncated,
        ...(page.nextContinuationToken !== undefined ? { cursor: page.nextContinuationToken } : {}),
      }
    }),
  }
}
