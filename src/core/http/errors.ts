import * as Schema from "effect/Schema"
import { ErrorSlug, type HeraSchemaIssue } from "../schema/index.js"
import type { RetryAfterParsed } from "./retry-after.js"

/**
 * Default maximum response body bytes read by `HeraHttp` (`64 KiB`).
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024

/**
 * Default whole-exchange HTTP timeout in milliseconds (`10,000ms`).
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000

/**
 * Typed error surfaced on `429 Too Many Requests` responses.
 *
 * `HeraHttp` never auto-retries `429` responses by default; callers inspect
 * `retryAfterSeconds` / `retryAfterMs` to schedule or fail fast.
 */
export class RateLimitedError extends Schema.TaggedError<RateLimitedError>()(
  "RateLimitedError",
  {
    slug: ErrorSlug,
    status: Schema.Literal(429),
    url: Schema.String,
    method: Schema.String,
    retryAfterSeconds: Schema.NullOr(Schema.Number),
    retryAfterMs: Schema.NullOr(Schema.Number),
    body: Schema.optional(Schema.String),
  }
) {
  static is(u: unknown): u is RateLimitedError {
    return (
      typeof u === "object" &&
      u !== null &&
      "_tag" in u &&
      (u as { readonly _tag?: unknown })._tag === "RateLimitedError"
    )
  }

  override get message(): string {
    const suffix =
      this.retryAfterSeconds !== null
        ? ` (retry after ${this.retryAfterSeconds}s)`
        : ""
    return `HTTP 429 Too Many Requests from ${this.method} ${this.url}${suffix}`
  }
}

export const HeraHttpErrorReasonSchema = Schema.Literals([
  "Timeout",
  "PayloadTooLarge",
  "NetworkError",
  "HttpStatusError",
  "DecodeError",
  "GraphqlError",
])
export type HeraHttpErrorReason = typeof HeraHttpErrorReasonSchema.Type

/**
 * One entry of a GraphQL `errors[]` reply, bounded by `extractGraphqlErrors`. `code` is the
 * entry's `extensions.code` when it is a string.
 */
export const HeraGraphqlErrorEntry = Schema.Struct({
  message: Schema.String,
  path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  code: Schema.optional(Schema.String),
})
export type HeraGraphqlErrorEntry = typeof HeraGraphqlErrorEntry.Type

/**
 * Typed error surfaced by `HeraHttp` on whole-exchange timeouts, oversized payloads,
 * network failures, non-2xx statuses, response schema decode failures, or
 * a GraphQL reply carrying `errors[]` (`GraphqlError`).
 */
export class HeraHttpError extends Schema.TaggedError<HeraHttpError>()(
  "HeraHttpError",
  {
    reason: HeraHttpErrorReasonSchema,
    slug: ErrorSlug,
    url: Schema.String,
    method: Schema.String,
    status: Schema.optional(Schema.Number),
    timeoutMs: Schema.optional(Schema.Number),
    maxBytes: Schema.optional(Schema.Number),
    body: Schema.optional(Schema.String),
    issues: Schema.optional(Schema.Array(Schema.Unknown)),
    graphqlErrors: Schema.optional(Schema.Array(HeraGraphqlErrorEntry)),
    cause: Schema.optional(Schema.Unknown),
  }
) {
  static is(u: unknown): u is HeraHttpError {
    return (
      typeof u === "object" &&
      u !== null &&
      "_tag" in u &&
      (u as { readonly _tag?: unknown })._tag === "HeraHttpError"
    )
  }

  override get message(): string {
    switch (this.reason) {
      case "Timeout":
        return `HTTP request timed out after ${this.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS}ms (${this.method} ${this.url})`
      case "PayloadTooLarge":
        return `HTTP response body exceeded maxBytes (${this.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES} bytes) from ${this.method} ${this.url}`
      case "HttpStatusError":
        return `HTTP ${this.status ?? 0} from ${this.method} ${this.url}`
      case "DecodeError":
        return `HTTP response failed schema validation from ${this.method} ${this.url}`
      case "NetworkError":
        return `HTTP network error from ${this.method} ${this.url}`
      case "GraphqlError":
        // Count only: an upstream message can echo a variable value.
        return `GraphQL errors (${this.graphqlErrors?.length ?? 0}) from ${this.method} ${this.url}`
    }
  }
}

export function makeTimeoutHttpError(
  url: string,
  method: string,
  timeoutMs: number
): HeraHttpError {
  return new HeraHttpError({
    reason: "Timeout",
    slug: ErrorSlug.make("http-timeout"),
    url,
    method,
    timeoutMs,
  })
}

export function makeNetworkHttpError(
  url: string,
  method: string,
  cause: unknown,
  status?: number
): HeraHttpError {
  return new HeraHttpError({
    reason: "NetworkError",
    slug: ErrorSlug.make("http-network-error"),
    url,
    method,
    ...(status !== undefined ? { status } : {}),
    cause,
  })
}

export function makePayloadTooLargeHttpError(
  url: string,
  method: string,
  status: number,
  maxBytes: number,
  body?: string
): HeraHttpError {
  return new HeraHttpError({
    reason: "PayloadTooLarge",
    slug: ErrorSlug.make("http-payload-too-large"),
    url,
    method,
    status,
    maxBytes,
    ...(body !== undefined ? { body } : {}),
  })
}

export function makeStatusHttpError(
  url: string,
  method: string,
  status: number,
  body: string
): HeraHttpError {
  return new HeraHttpError({
    reason: "HttpStatusError",
    slug: ErrorSlug.make("http-status-error"),
    url,
    method,
    status,
    body,
  })
}

export function makeDecodeHttpError(
  url: string,
  method: string,
  status: number,
  cause: unknown,
  issues?: ReadonlyArray<HeraSchemaIssue>
): HeraHttpError {
  return new HeraHttpError({
    reason: "DecodeError",
    slug: ErrorSlug.make("http-decode-error"),
    url,
    method,
    status,
    ...(issues !== undefined ? { issues } : {}),
    cause,
  })
}

export function makeRateLimitedHttpError(
  url: string,
  method: string,
  resolved: RetryAfterParsed,
  body: string
): RateLimitedError {
  return new RateLimitedError({
    slug: ErrorSlug.make("http-rate-limited"),
    status: 429,
    url,
    method,
    retryAfterSeconds: resolved.retryAfterSeconds,
    retryAfterMs: resolved.retryAfterMs,
    body,
  })
}

export function makeGraphqlHttpError(
  url: string,
  method: string,
  status: number,
  graphqlErrors: ReadonlyArray<HeraGraphqlErrorEntry>
): HeraHttpError {
  return new HeraHttpError({
    reason: "GraphqlError",
    slug: ErrorSlug.make("http-graphql-error"),
    url,
    method,
    status,
    graphqlErrors,
  })
}
