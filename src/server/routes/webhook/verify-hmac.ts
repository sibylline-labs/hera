/**
 * `HeraWebhook.verifyHmac`: verify a signed webhook delivery and hand back its raw body.
 *
 * Invariants:
 *  - Digests are compared only by `crypto.subtle.verify`, which is constant time. Never `===`,
 *    a byte loop or any other compare of two digests: a caller that learns how many leading bytes
 *    matched can forge a signature one byte at a time. Every key is verified (no early exit), so
 *    the timing does not say which key matched.
 *  - Order is cost order: body cap, then the signature's shape (before any key import), then the
 *    key set, then the HMAC, then the timestamp. A body `read` runs only on a verified body.
 *  - A header timestamp (its own header, or the one `parse` read from the signature header) is
 *    inside the HMAC (`payload(timestamp, body)`): an unsigned one could be rewritten, and a
 *    captured delivery would replay forever.
 *  - With `parse`, every key is verified against every candidate (at most 8), and any match
 *    admits; the candidate list is bounded before any key import.
 *  - Every refusal but the cap is the same `401 invalid_signature` with the same detail, so the
 *    response does not say which check refused. The reason is the error's `cause`
 *    (`HeraWebhookRefusal`), read with `refusalReason`; it never carries a secret, signature or
 *    body byte. Nothing here logs: the caller owns its log line.
 *  - The request body is consumed: the returned bytes are the caller's only copy.
 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { HeraError } from "../../../core/errors/index.js"
import { fn } from "../../../core/fn/index.js"
import { readBytesBounded } from "../../../core/http/index.js"
import { decodeCandidates } from "./candidates.js"
import {
  decodeSignature,
  parseHeaderTimestamp,
  secretKeyBytes,
  withinTolerance,
} from "./signature.js"
import {
  HeraWebhookRefusal,
  type HeraWebhookOptions,
  type HeraWebhookRefusalReason,
} from "./types.js"

const DEFAULT_MAX_BYTES = 64 * 1024
const PUBLIC_DETAIL = "Invalid request signature"

function refuse(reason: HeraWebhookRefusalReason): HeraError {
  const cause = new HeraWebhookRefusal(reason)
  return reason === "too_large"
    ? HeraError.payloadTooLarge(undefined, { code: "payload_too_large", cause })
    : HeraError.unauthorized(PUBLIC_DETAIL, { code: "invalid_signature", cause })
}

/** The refusal reason of an error `verifyHmac` failed with, or `undefined` for any other value. */
export function refusalReason(error: unknown): HeraWebhookRefusalReason | undefined {
  return HeraError.is(error) && error.cause instanceof HeraWebhookRefusal
    ? error.cause.reason
    : undefined
}

function assertOptions(options: HeraWebhookOptions): void {
  if (options.header.trim() === "") {
    throw new Error("HeraWebhook.verifyHmac: header must be a non-empty header name")
  }
  if (options.maxBytes !== undefined && !(Number.isInteger(options.maxBytes) && options.maxBytes > 0)) {
    throw new Error("HeraWebhook.verifyHmac: maxBytes must be a positive integer")
  }
  const timestamp = options.timestamp
  if (timestamp === undefined) return
  if (!(Number.isFinite(timestamp.toleranceMs) && timestamp.toleranceMs > 0)) {
    throw new Error("HeraWebhook.verifyHmac: timestamp.toleranceMs must be a positive number")
  }
  if (timestamp.header !== undefined && timestamp.header.trim() === "") {
    throw new Error("HeraWebhook.verifyHmac: timestamp.header must be a non-empty header name")
  }
  if (timestamp.header !== undefined && typeof timestamp.payload !== "function") {
    throw new Error("HeraWebhook.verifyHmac: a header timestamp needs timestamp.payload, so the HMAC covers it")
  }
  if (timestamp.signed === true) {
    if (options.parse === undefined) {
      throw new Error("HeraWebhook.verifyHmac: timestamp.signed needs options.parse to read the timestamp")
    }
    if (typeof timestamp.payload !== "function") {
      throw new Error("HeraWebhook.verifyHmac: timestamp.signed needs timestamp.payload, so the HMAC covers it")
    }
  }
}

async function verifyAny(
  keys: ReadonlyArray<Uint8Array<ArrayBuffer>>,
  hash: string,
  signatures: ReadonlyArray<Uint8Array<ArrayBuffer>>,
  body: Uint8Array<ArrayBuffer>
): Promise<boolean> {
  const results = await Promise.all(
    keys.map(async (keyBytes) => {
      const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash }, false, [
        "verify",
      ])
      return Promise.all(
        signatures.map((signature) => crypto.subtle.verify("HMAC", key, signature, body))
      )
    })
  )
  return results.flat().includes(true)
}

/**
 * Builds a verifier for one webhook provider. Options are checked here and throw on a programming
 * error; the returned function succeeds with the raw body bytes or fails with `HeraError`
 * `401 invalid_signature` (any signature, key or timestamp refusal) or `413 payload_too_large`.
 */
export function verifyHmac(
  options: HeraWebhookOptions
): (request: Request) => Effect.Effect<Uint8Array<ArrayBuffer>, HeraError> {
  assertOptions(options)
  const algo = options.algo ?? "SHA-256"
  const encoding = options.encoding ?? "hex"
  const prefix = options.prefix ?? ""
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const timestamp = options.timestamp

  return fn("HeraWebhook.verifyHmac")(function* (request: Request) {
    const declared = request.headers.get("content-length")
    if (declared !== null && Number(declared) > maxBytes) {
      return yield* Effect.fail(refuse("too_large"))
    }
    const read = yield* Effect.tryPromise({
      try: () => readBytesBounded(request.body, maxBytes),
      catch: () => refuse("bad_signature"),
    })
    if (read.truncated) return yield* Effect.fail(refuse("too_large"))
    const body = read.bytes

    const header = request.headers.get(options.header)
    if (header === null) return yield* Effect.fail(refuse("missing_signature"))
    const parse = options.parse
    let signatures: ReadonlyArray<Uint8Array<ArrayBuffer>> | undefined
    let parsedTimestamp: string | undefined
    if (parse !== undefined) {
      const parsed = yield* Effect.try({
        try: () => parse(header),
        catch: () => refuse("malformed_signature"),
      })
      if (parsed === undefined) return yield* Effect.fail(refuse("malformed_signature"))
      parsedTimestamp = parsed.timestamp
      signatures = decodeCandidates(parsed.signatures, algo, encoding, prefix)
    } else {
      const single = decodeSignature(header, algo, encoding, prefix)
      signatures = single === undefined ? undefined : [single]
    }
    if (signatures === undefined) return yield* Effect.fail(refuse("malformed_signature"))

    const keys = secretKeyBytes(options.secret)
    if (keys.length === 0) return yield* Effect.fail(refuse("unconfigured"))

    // A header timestamp is signed with the body, so rewriting it breaks the HMAC.
    const headerTimestamp =
      timestamp?.header !== undefined
        ? request.headers.get(timestamp.header)
        : timestamp?.signed === true
          ? (parsedTimestamp ?? null)
          : undefined
    if (headerTimestamp === null) return yield* Effect.fail(refuse("missing_timestamp"))
    let signed: Uint8Array<ArrayBuffer> = body
    if (timestamp !== undefined && timestamp.read === undefined && headerTimestamp !== undefined) {
      const build = timestamp.payload
      signed = yield* Effect.try({
        try: () => new Uint8Array(build(headerTimestamp, body)),
        catch: () => refuse("bad_signature"),
      })
    }

    const verified = yield* Effect.tryPromise({
      try: () => verifyAny(keys, algo, signatures, signed),
      catch: () => refuse("bad_signature"),
    })
    if (!verified) return yield* Effect.fail(refuse("bad_signature"))

    if (timestamp !== undefined) {
      const unit = timestamp.unit ?? "ms"
      let timestampMs: number | undefined
      if (headerTimestamp !== undefined) {
        timestampMs = parseHeaderTimestamp(headerTimestamp, unit)
      } else if (timestamp.read !== undefined) {
        const readTimestamp = timestamp.read
        const raw = yield* Effect.try({
          try: () => readTimestamp(body),
          catch: () => refuse("missing_timestamp"),
        })
        timestampMs = raw === undefined ? undefined : unit === "s" ? raw * 1000 : raw
      }
      if (timestampMs === undefined) return yield* Effect.fail(refuse("missing_timestamp"))
      const nowMs = yield* Clock.currentTimeMillis
      if (!withinTolerance(timestampMs, nowMs, timestamp.toleranceMs)) {
        return yield* Effect.fail(refuse("stale"))
      }
    }
    return body
  })
}
