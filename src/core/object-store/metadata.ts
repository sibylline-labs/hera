import { HeraError } from "../errors/index.js"
import type { HeraObjectStoreOp } from "./types.js"

const META_KEY = /^[a-z0-9][a-z0-9_-]{0,127}$/
// Printable ASCII with single inner spaces: HTTP trims edge whitespace and SigV4 collapses inner
// runs, so either would not read back equal.
const META_VALUE = /^(?:[\x21-\x7e]+(?: [\x21-\x7e]+)*)?$/
const META_PREFIX = "x-amz-meta-"
const MAX_KEY_BYTES = 1024

/** The `invalid_request` refusal for a caller input the store cannot send; names the input, not its value. */
export function invalidRequest(op: HeraObjectStoreOp, what: string): HeraError {
  return HeraError.badRequest(`Invalid object store ${what}`, {
    code: "invalid_request",
    fields: { op, invalid: what },
  })
}

/**
 * `null` when `key` is a storable object key, else the `invalid_request` refusal: 1–1024 UTF-8
 * bytes and no `.` / `..` segment, which URL parsing collapses (even percent-encoded), so
 * `../other/x` would address another bucket. Shared by every store so the fake refuses what the
 * transport would.
 */
export function checkObjectKey(op: HeraObjectStoreOp, key: string): HeraError | null {
  const bytes = new TextEncoder().encode(key).byteLength
  const dotSegment = key.split("/").some((segment) => segment === "." || segment === "..")
  return bytes === 0 || bytes > MAX_KEY_BYTES || dotSegment ? invalidRequest(op, "key") : null
}

/**
 * `null` when every entry round-trips identically over S3 `x-amz-meta-*` headers and a Worker
 * binding's `customMetadata`, else the `invalid_request` refusal (the key name is not echoed).
 */
export function checkCustomMetadata(
  op: HeraObjectStoreOp,
  metadata: Readonly<Record<string, string>> | undefined
): HeraError | null {
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!META_KEY.test(key)) {
      return invalidRequest(op, "metadata key")
    }
    if (typeof value !== "string" || !META_VALUE.test(value)) {
      return invalidRequest(op, "metadata value")
    }
  }
  return null
}

export function metadataHeaders(
  metadata: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    headers[`${META_PREFIX}${key}`] = value
  }
  return headers
}

export function readMetadata(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {}
  headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (lower.startsWith(META_PREFIX)) {
      metadata[lower.slice(META_PREFIX.length)] = value
    }
  })
  return metadata
}

/** `abc` → `"abc"`; `*`, a quoted etag and a weak `W/"…"` etag pass through. */
export function quoteEtag(etag: string): string {
  return etag === "*" || etag.startsWith('"') || etag.startsWith('W/"') ? etag : `"${etag}"`
}

/** `"abc"` (or `W/"abc"`) → `abc`. */
export function unquoteEtag(etag: string): string {
  const bare = etag.startsWith("W/") ? etag.slice(2) : etag
  return bare.length >= 2 && bare.startsWith('"') && bare.endsWith('"')
    ? bare.slice(1, -1)
    : bare
}

/** RFC 3986 encoding of each `/`-separated segment, as S3 path-style URLs and SigV4 expect. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/")
}
