import * as Schema from "effect/Schema"
import { ErrorSlug } from "../../schema/index.js"
import { HeraHttpErrorReasonSchema } from "../errors.js"

export const HeraOAuth2ErrorReasonSchema = Schema.Literals([
  "invalid_grant",
  "invalid_client",
  "upstream",
])
export type HeraOAuth2ErrorReason = typeof HeraOAuth2ErrorReasonSchema.Type

export const HeraOAuth2OpSchema = Schema.Literals(["exchange_code", "refresh", "revoke"])
export type HeraOAuth2Op = typeof HeraOAuth2OpSchema.Type

/** What failed underneath an `upstream` reason: a `HeraHttpError` reason, or a `429`. */
export const HeraOAuth2UpstreamSchema = Schema.Union([
  HeraHttpErrorReasonSchema,
  Schema.Literal("RateLimited"),
])
export type HeraOAuth2Upstream = typeof HeraOAuth2UpstreamSchema.Type

/**
 * Typed failure of a `HeraOAuth2` client call, in the order a caller acts on it:
 * `invalid_grant` is a dead authorization code or refresh token (the user must connect again);
 * `invalid_client` is the client's own id or secret being wrong, which says nothing about any
 * one connection and must never disconnect one; `upstream` is every other failure.
 *
 * Carries no response body, form field, token or exception: only the status and a bare RFC 6749
 * `error` code (`oauthCode`), so it is safe to log and serialize.
 */
export class HeraOAuth2Error extends Schema.TaggedError<HeraOAuth2Error>()(
  "HeraOAuth2Error",
  {
    reason: HeraOAuth2ErrorReasonSchema,
    slug: ErrorSlug,
    op: HeraOAuth2OpSchema,
    url: Schema.String,
    status: Schema.optional(Schema.Number),
    oauthCode: Schema.optional(Schema.String),
    upstream: Schema.optional(HeraOAuth2UpstreamSchema),
    retryAfterMs: Schema.optional(Schema.NullOr(Schema.Number)),
  }
) {
  static is(u: unknown): u is HeraOAuth2Error {
    return (
      typeof u === "object" &&
      u !== null &&
      "_tag" in u &&
      (u as { readonly _tag?: unknown })._tag === "HeraOAuth2Error"
    )
  }

  override get message(): string {
    const status = this.status !== undefined ? ` HTTP ${this.status}` : ""
    const code = this.oauthCode !== undefined ? ` (${this.oauthCode})` : ""
    const upstream = this.upstream !== undefined ? ` [${this.upstream}]` : ""
    return `OAuth2 ${this.op} failed: ${this.reason}${status}${code}${upstream} from ${this.url}`
  }
}

const SLUGS = {
  invalid_grant: "oauth2-invalid-grant",
  invalid_client: "oauth2-invalid-client",
  upstream: "oauth2-upstream",
} as const satisfies Record<HeraOAuth2ErrorReason, string>

export function makeOAuth2Error(
  reason: HeraOAuth2ErrorReason,
  op: HeraOAuth2Op,
  url: string,
  extra: {
    readonly status?: number | undefined
    readonly oauthCode?: string | null | undefined
    readonly upstream?: HeraOAuth2Upstream | undefined
    readonly retryAfterMs?: number | null | undefined
  } = {}
): HeraOAuth2Error {
  return new HeraOAuth2Error({
    reason,
    slug: ErrorSlug.make(SLUGS[reason]),
    op,
    url,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.oauthCode !== undefined && extra.oauthCode !== null
      ? { oauthCode: extra.oauthCode }
      : {}),
    ...(extra.upstream !== undefined ? { upstream: extra.upstream } : {}),
    ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
  })
}
