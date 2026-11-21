import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { request } from "../client.js"
import { type HeraHttpError, RateLimitedError } from "../errors.js"
import {
  type HeraOAuth2Error,
  type HeraOAuth2Op,
  makeOAuth2Error,
} from "./errors.js"
import {
  type HeraOAuth2TokenPair,
  parseOAuthCode,
  parseTokenPair,
  tokenFailureReason,
} from "./token-pair.js"

export interface HeraOAuth2ClientConfig {
  readonly tokenUrl: string
  readonly revokeUrl: string
  readonly clientId: string | Redacted.Redacted<string>
  readonly clientSecret: Redacted.Redacted<string>
  /**
   * Send `client_id` / `client_secret` on revoke too (RFC 7009). Off by default: Linear's
   * revoke endpoint takes no client authentication, and a secret goes nowhere it is not needed.
   */
  readonly revokeClientAuth?: boolean | undefined
  readonly timeoutMs?: number | undefined
  readonly maxBytes?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  /** Clock for `expiresAt`, in epoch ms (default `Date.now`). */
  readonly nowMs?: (() => number) | undefined
}

export type HeraOAuth2TokenHint = "access_token" | "refresh_token"

export interface HeraOAuth2Client {
  /** Trades an authorization code for the first pair; `redirectUri` must match the authorize request's. */
  readonly exchangeCode: (input: {
    readonly code: string
    readonly redirectUri: string
  }) => Effect.Effect<HeraOAuth2TokenPair, HeraOAuth2Error>
  /** Trades a refresh token for a new pair. Persist the new `refreshToken` before using the access token. */
  readonly refresh: (
    refreshToken: Redacted.Redacted<string>
  ) => Effect.Effect<HeraOAuth2TokenPair, HeraOAuth2Error>
  /**
   * Revokes one token. `already_invalid` (HTTP 400/401) is a success: the token no longer works,
   * which is all a disconnect needs, so a retry loop on it would never end. A 400/401 whose
   * `error` is `invalid_client` stays a failure: the endpoint rejected the client, not the token,
   * so the token may still be live.
   */
  readonly revoke: (
    token: Redacted.Redacted<string>,
    hint: HeraOAuth2TokenHint
  ) => Effect.Effect<"revoked" | "already_invalid", HeraOAuth2Error>
}

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" } as const

/** Maps an exchange failure to an OAuth failure, dropping its body: only status and a bare code survive. */
function fromHttpError(
  op: HeraOAuth2Op,
  url: string,
  err: HeraHttpError | RateLimitedError
): HeraOAuth2Error {
  if (RateLimitedError.is(err)) {
    return makeOAuth2Error("upstream", op, url, {
      status: 429,
      upstream: "RateLimited",
      retryAfterMs: err.retryAfterMs,
    })
  }
  if (err.reason === "HttpStatusError" && err.status !== undefined) {
    const code = parseOAuthCode(err.body)
    return makeOAuth2Error(tokenFailureReason(err.status, code), op, url, {
      status: err.status,
      oauthCode: code,
      upstream: err.reason,
    })
  }
  return makeOAuth2Error("upstream", op, url, {
    status: err.status,
    upstream: err.reason,
  })
}

/**
 * An OAuth 2.0 client over `HeraHttp`: the authorization-code exchange, refresh and
 * revoke, with client credentials sent as form body params (`client_secret_post`). Timeout and
 * `maxBytes` bounds are the exchange's; every failure is a typed `HeraOAuth2Error`.
 */
export function client(config: HeraOAuth2ClientConfig): HeraOAuth2Client {
  const nowMs = config.nowMs ?? Date.now
  const transport = {
    timeoutMs: config.timeoutMs,
    maxBytes: config.maxBytes,
    fetch: config.fetch,
  }
  const clientFields = (): Record<string, string> => ({
    client_id: Redacted.isRedacted(config.clientId)
      ? Redacted.value(config.clientId)
      : config.clientId,
    client_secret: Redacted.value(config.clientSecret),
  })

  // Redirects are never followed: a 3xx would re-send the form (client secret, code, token) to
  // whatever origin `location` names, so it fails `upstream` instead.
  const post = (op: HeraOAuth2Op, url: string, form: () => Record<string, string>) =>
    Effect.suspend(() =>
      request({
        ...transport,
        url,
        method: "POST",
        headers: FORM_HEADERS,
        body: new URLSearchParams(form()).toString(),
        redirect: "manual",
      })
    ).pipe(
      Effect.mapError((err) => fromHttpError(op, url, err)),
      Effect.flatMap((res) =>
        res.status >= 300 && res.status < 400
          ? Effect.fail(
              makeOAuth2Error("upstream", op, url, {
                status: res.status,
                upstream: "HttpStatusError",
              })
            )
          : Effect.succeed(res)
      )
    )

  const tokenGrant = (op: HeraOAuth2Op, form: () => Record<string, string>) =>
    post(op, config.tokenUrl, () => ({ ...form(), ...clientFields() })).pipe(
      Effect.flatMap((res) => {
        const pair = parseTokenPair(res.text, nowMs())
        return pair === null
          ? Effect.fail(
              makeOAuth2Error("upstream", op, config.tokenUrl, {
                status: res.status,
                upstream: "DecodeError",
              })
            )
          : Effect.succeed(pair)
      })
    )

  return {
    exchangeCode: ({ code, redirectUri }) =>
      tokenGrant("exchange_code", () => ({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      })),
    refresh: (refreshToken) =>
      tokenGrant("refresh", () => ({
        grant_type: "refresh_token",
        refresh_token: Redacted.value(refreshToken),
      })),
    revoke: (token, hint) =>
      post("revoke", config.revokeUrl, () => ({
        token: Redacted.value(token),
        token_type_hint: hint,
        ...(config.revokeClientAuth === true ? clientFields() : {}),
      })).pipe(
        Effect.as("revoked" as const),
        Effect.catch((err) =>
          (err.status === 400 || err.status === 401) &&
          err.upstream === "HttpStatusError" &&
          err.reason !== "invalid_client"
            ? Effect.succeed("already_invalid" as const)
            : Effect.fail(err)
        )
      ),
  }
}
