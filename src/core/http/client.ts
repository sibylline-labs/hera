import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { decodeResult } from "../schema/index.js"
import {
  type HeraHttpBytesRequestOptions,
  type HeraHttpBytesResponse,
  type HeraHttpMethodShorthandOptions,
  type HeraHttpRequestOptions,
  type HeraHttpResponse,
  readBytesBounded,
  readTextBounded,
} from "./body-reader.js"
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  HeraHttpError,
  makeDecodeHttpError,
  RateLimitedError,
} from "./errors.js"
import { exchange } from "./exchange.js"
import { connectionPages } from "./connection-pages.js"
import { createOnce } from "./create-once.js"
import { graphql } from "./graphql.js"
import { gunzipBase64Bounded, gunzipBounded } from "./gunzip.js"
import { toProblemResponse } from "./problem-response.js"
import { raw } from "./raw.js"
import { HeraBodyReadError, readBody } from "./request-body.js"
import { sse } from "./sse.js"
import { parseRetryAfter } from "./retry-after.js"

/**
 * Executes an HTTP request with a single whole-exchange timeout (`AbortController` +
 * `Effect.timeout` spanning connect, headers, bounded body stream, and schema decode),
 * bounded streaming body reader (`maxBytes`, default 64 KiB), RFC 9110 `Retry-After`
 * parsing on `429` into `RateLimitedError` (never auto-retried), and optional `HeraSchema`
 * response validation. The body is decoded as UTF-8 text; use
 * `requestBytes` for binary bodies.
 */
export function request<S extends Schema.Top | undefined = undefined>(
  options: HeraHttpRequestOptions<S>
): Effect.Effect<
  HeraHttpResponse<S extends Schema.Top ? S["Type"] : string>,
  RateLimitedError | HeraHttpError
> {
  type Data = S extends Schema.Top ? S["Type"] : string
  return exchange(options as HeraHttpRequestOptions<never>, ({ url, method, res, body }) => {
    const text = new TextDecoder().decode(body.bytes)
    const base = {
      status: res.status,
      headers: res.headers,
      text,
      truncated: body.truncated,
      byteLength: body.byteLength,
    }
    if (options.schema === undefined) {
      return Effect.succeed({ ...base, data: text as Data })
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(text)
    } catch (cause) {
      return Effect.fail(makeDecodeHttpError(url, method, res.status, cause))
    }
    const decoded = decodeResult(options.schema, parsedJson)
    if (decoded._tag === "Failure") {
      return Effect.fail(
        makeDecodeHttpError(
          url,
          method,
          res.status,
          decoded.failure,
          decoded.failure.issues
        )
      )
    }
    return Effect.succeed({ ...base, data: decoded.success as Data })
  })
}

/**
 * Same exchange as `request` (timeout, `maxBytes`, `429`, non-2xx, `redirect`), but the
 * body comes back as the exact bytes read, never decoded as text, for hashing or relaying
 * a binary payload. Error bodies on `HeraHttpError` / `RateLimitedError` are still text.
 */
export function requestBytes(
  options: HeraHttpBytesRequestOptions
): Effect.Effect<HeraHttpBytesResponse, RateLimitedError | HeraHttpError> {
  return exchange(options, ({ res, body }) =>
    Effect.succeed({
      status: res.status,
      headers: res.headers,
      bytes: body.bytes,
      truncated: body.truncated,
      byteLength: body.byteLength,
    })
  )
}

export function get<S extends Schema.Top | undefined = undefined>(
  url: string,
  options?: HeraHttpMethodShorthandOptions<S>
): Effect.Effect<
  HeraHttpResponse<S extends Schema.Top ? S["Type"] : string>,
  RateLimitedError | HeraHttpError
> {
  return request({ ...options, url, method: "GET" })
}

export function post<S extends Schema.Top | undefined = undefined>(
  url: string,
  options?: HeraHttpMethodShorthandOptions<S>
): Effect.Effect<
  HeraHttpResponse<S extends Schema.Top ? S["Type"] : string>,
  RateLimitedError | HeraHttpError
> {
  return request({ ...options, url, method: "POST" })
}

export function put<S extends Schema.Top | undefined = undefined>(
  url: string,
  options?: HeraHttpMethodShorthandOptions<S>
): Effect.Effect<
  HeraHttpResponse<S extends Schema.Top ? S["Type"] : string>,
  RateLimitedError | HeraHttpError
> {
  return request({ ...options, url, method: "PUT" })
}

export function patch<S extends Schema.Top | undefined = undefined>(
  url: string,
  options?: HeraHttpMethodShorthandOptions<S>
): Effect.Effect<
  HeraHttpResponse<S extends Schema.Top ? S["Type"] : string>,
  RateLimitedError | HeraHttpError
> {
  return request({ ...options, url, method: "PATCH" })
}

export function del<S extends Schema.Top | undefined = undefined>(
  url: string,
  options?: HeraHttpMethodShorthandOptions<S>
): Effect.Effect<
  HeraHttpResponse<S extends Schema.Top ? S["Type"] : string>,
  RateLimitedError | HeraHttpError
> {
  return request({ ...options, url, method: "DELETE" })
}

export const HeraHttp = {
  toProblemResponse,
  raw,
  sse,
  parseRetryAfter,
  readTextBounded,
  readBytesBounded,
  gunzipBounded,
  gunzipBase64Bounded,
  readBody,
  request,
  requestBytes,
  get,
  post,
  put,
  patch,
  delete: del,
  graphql,
  createOnce,
  connectionPages,
  RateLimitedError,
  HeraHttpError,
  HeraBodyReadError,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_TIMEOUT_MS,
} as const
