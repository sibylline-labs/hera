import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import { decodeResult } from "../schema/index.js"
import type { HeraHttpRequestOptions, HttpHeaderValue } from "./body-reader.js"
import {
  HeraHttpError,
  makeDecodeHttpError,
  makeGraphqlHttpError,
  makeStatusHttpError,
  type RateLimitedError,
} from "./errors.js"
import { exchange } from "./exchange.js"
import { graphqlErrorsInBody } from "./graphql-body-errors.js"
import { extractGraphqlErrors } from "./graphql-errors.js"

/**
 * The credential a GraphQL call carries: `bearer` is sent as `Authorization: Bearer <token>`,
 * `authorization` as the raw header value (e.g. a Linear personal API key). Both are `Redacted`
 * and unwrapped only when the request is built.
 */
export type HeraGraphqlAuth =
  | { readonly bearer: Redacted.Redacted<string> }
  | { readonly authorization: Redacted.Redacted<string> }

export interface HeraGraphqlOptions<S extends Schema.Top> {
  readonly url: string
  readonly query: string
  readonly variables?: Readonly<Record<string, unknown>> | undefined
  readonly operationName?: string | undefined
  /** Decodes the reply's `data` member. */
  readonly schema: S
  readonly auth?: HeraGraphqlAuth | undefined
  readonly headers?: Readonly<Record<string, HttpHeaderValue | undefined>> | undefined
  readonly timeoutMs?: number | undefined
  readonly maxBytes?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}

export interface HeraGraphqlResponse<T> {
  readonly status: number
  readonly headers: Headers
  readonly data: T
}

function authorizationHeader(auth: HeraGraphqlAuth): Redacted.Redacted<string> {
  if ("bearer" in auth) {
    return Redacted.make(`Bearer ${Redacted.value(auth.bearer)}`)
  }
  return auth.authorization
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * The exchange's non-2xx `HttpStatusError` with the GraphQL `errors[]` its body carries attached
 * as `graphqlErrors`; `reason`, `status`, `slug` and `body` are kept.
 */
function withBodyGraphqlErrors<E>(error: E): E | HeraHttpError {
  if (
    !HeraHttpError.is(error) ||
    error.reason !== "HttpStatusError" ||
    error.graphqlErrors !== undefined ||
    !error.body
  ) {
    return error
  }
  const graphqlErrors = graphqlErrorsInBody(error.body)
  if (graphqlErrors === null) {
    return error
  }
  return new HeraHttpError({
    reason: error.reason,
    slug: error.slug,
    url: error.url,
    method: error.method,
    ...(error.status !== undefined ? { status: error.status } : {}),
    body: error.body,
    graphqlErrors,
  })
}

/**
 * POSTs one GraphQL operation through the `HeraHttp` exchange (same timeout, `maxBytes`, `429`
 * and non-2xx handling). A 2xx is not success on its own: a body that is not a JSON object is a
 * `DecodeError`, a non-empty or non-list `errors` is a `GraphqlError` carrying the bounded
 * entries (even beside partial `data`), and `data` must decode against `schema`. Redirects are
 * never followed: a 3xx is an `HttpStatusError`. `auth`, when given, replaces any `authorization`
 * in `headers`. A non-2xx whose body is a JSON object with a non-empty `errors` list stays an
 * `HttpStatusError` and carries those bounded entries on `graphqlErrors`.
 */
export function graphql<S extends Schema.Top>(
  options: HeraGraphqlOptions<S>
): Effect.Effect<HeraGraphqlResponse<S["Type"]>, RateLimitedError | HeraHttpError> {
  const request: HeraHttpRequestOptions<never> = {
    url: options.url,
    method: "POST",
    headers: {
      ...options.headers,
      ...(options.auth !== undefined
        ? { authorization: authorizationHeader(options.auth) }
        : {}),
      accept: "application/json",
    },
    // Never followed: a redirect would carry the credential, or decode another origin's `data`.
    redirect: "manual",
    body: {
      query: options.query,
      ...(options.variables !== undefined ? { variables: options.variables } : {}),
      ...(options.operationName !== undefined
        ? { operationName: options.operationName }
        : {}),
    },
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    fetch: options.fetch,
  }
  const exchanged = exchange(request, ({ url, method, res, body }) => {
    if (res.status >= 300 && res.status < 400) {
      return Effect.fail(makeStatusHttpError(url, method, res.status, ""))
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes))
    } catch (cause) {
      return Effect.fail(makeDecodeHttpError(url, method, res.status, cause))
    }
    if (!isRecord(parsed)) {
      return Effect.fail(
        makeDecodeHttpError(url, method, res.status, "GraphQL reply is not a JSON object")
      )
    }
    const errors = extractGraphqlErrors(parsed.errors)
    if (errors !== null) {
      return Effect.fail(makeGraphqlHttpError(url, method, res.status, errors))
    }
    const decoded = decodeResult(options.schema, parsed.data ?? null)
    if (decoded._tag === "Failure") {
      return Effect.fail(
        makeDecodeHttpError(url, method, res.status, decoded.failure, decoded.failure.issues)
      )
    }
    return Effect.succeed({
      status: res.status,
      headers: res.headers,
      data: decoded.success as S["Type"],
    })
  })
  return Effect.mapError(exchanged, withBodyGraphqlErrors)
}
