import { HeraError } from "../errors/index.js"
import { type HeraHttpError, RateLimitedError } from "../http/index.js"
import { parseS3ErrorCode } from "./s3-xml.js"
import type { HeraObjectStoreOp } from "./types.js"

/**
 * A failed `ifMatch` / `ifNoneMatch: "*"`. `object` names the key (a `key` field would be
 * redacted by the error-field sanitizer).
 */
export function preconditionFailed(op: HeraObjectStoreOp, key: string): HeraError {
  return HeraError.preconditionFailed("Object store precondition failed", {
    fields: { op, object: key },
  })
}

export function upstreamError(
  op: HeraObjectStoreOp,
  extra: {
    readonly status?: number | undefined
    readonly upstream: string
    readonly s3Code?: string | undefined
  }
): HeraError {
  return HeraError.badGateway("Object store upstream error", {
    code: "upstream_error",
    fields: {
      op,
      upstream: extra.upstream,
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      ...(extra.s3Code !== undefined ? { s3Code: extra.s3Code } : {}),
    },
  })
}

/**
 * Maps an exchange failure to the closed catalog: `412` → `precondition_failed`,
 * `429` → `rate_limited`, everything else → `upstream_error`. Callers map `304` / `404` to
 * results first. No response body, URL or header value is carried: only the op, status, the
 * `HeraHttpError` reason and the S3 `<Code>`.
 */
export function toStoreError(
  op: HeraObjectStoreOp,
  key: string,
  err: HeraHttpError | RateLimitedError
): HeraError {
  if (RateLimitedError.is(err)) {
    return HeraError.rateLimited("Object store rate limited", {
      ...(err.retryAfterSeconds !== null ? { retryAfter: err.retryAfterSeconds } : {}),
      fields: { op },
    })
  }
  if (err.reason === "HttpStatusError" && err.status === 412) {
    return preconditionFailed(op, key)
  }
  return upstreamError(op, {
    status: err.status,
    upstream: err.reason,
    s3Code: err.reason === "HttpStatusError" ? parseS3ErrorCode(err.body) : undefined,
  })
}
