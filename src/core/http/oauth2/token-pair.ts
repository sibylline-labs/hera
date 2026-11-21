import * as Redacted from "effect/Redacted"
import type { HeraOAuth2ErrorReason } from "./errors.js"

/**
 * One access/refresh pair. A refresh may rotate both, so the caller persists `refreshToken`
 * before it uses `accessToken`.
 */
export interface HeraOAuth2TokenPair {
  readonly accessToken: Redacted.Redacted<string>
  readonly refreshToken: Redacted.Redacted<string>
  /** Epoch ms at which the access token stops working: `now` plus `expires_in` seconds. */
  readonly expiresAt: number
  readonly scopes: ReadonlyArray<string>
}

/**
 * The registered OAuth `error` codes (RFC 6749 §4.1.2.1, §5.2; RFC 7009 §2.2.1). Anything else is
 * dropped, not echoed: an upstream string could be a token or a credential.
 */
const OAUTH_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "unsupported_response_type",
  "server_error",
  "temporarily_unavailable",
  "unsupported_token_type",
])

function parseJson(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined
}

/** The OAuth `error` code of an error body, or `null` when it is not JSON or not a registered code. */
export function parseOAuthCode(body: string | undefined): string | null {
  const code = field(parseJson(body), "error")
  return typeof code === "string" && OAUTH_CODES.has(code) ? code : null
}

/**
 * The reason a non-2xx from a token endpoint is. Only the exact RFC 6749 shape maps to a specific
 * reason: a dead grant is HTTP 400, a bad client 400 or 401. Anything else is `upstream`, because
 * a wrong `invalid_grant` makes a caller disconnect a working connection.
 */
export function tokenFailureReason(
  status: number,
  code: string | null
): HeraOAuth2ErrorReason {
  if (code === "invalid_client" && (status === 400 || status === 401)) {
    return "invalid_client"
  }
  if (code === "invalid_grant" && status === 400) {
    return "invalid_grant"
  }
  return "upstream"
}

/** `scope` as a space- or comma-separated string, or an array; anything else is no scopes. */
export function parseScopes(scope: unknown): ReadonlyArray<string> {
  const parts =
    typeof scope === "string"
      ? scope.split(/[\s,]+/)
      : Array.isArray(scope)
        ? scope
        : []
  return parts.filter((s): s is string => typeof s === "string" && s.length > 0)
}

const nonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null

/**
 * A 2xx body is a pair only when both tokens are non-empty strings and `expires_in` is a positive
 * number whose expiry is finite: a half-formed pair taken as success strands a connection on a
 * token that cannot refresh.
 */
export function parseTokenPair(
  text: string,
  nowMs: number
): HeraOAuth2TokenPair | null {
  const body = parseJson(text)
  const accessToken = nonEmptyString(field(body, "access_token"))
  const refreshToken = nonEmptyString(field(body, "refresh_token"))
  const expiresIn = field(body, "expires_in")
  if (accessToken === null || refreshToken === null) {
    return null
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null
  }
  const expiresAt = nowMs + expiresIn * 1000
  if (!Number.isFinite(expiresAt)) {
    return null
  }
  return {
    accessToken: Redacted.make(accessToken),
    refreshToken: Redacted.make(refreshToken),
    expiresAt,
    scopes: parseScopes(field(body, "scope")),
  }
}
