import * as Effect from "effect/Effect"
import {
  type BoundedBytesResult,
  buildRequestHeaders,
  type HeraHttpRequestOptions,
  type HttpMethod,
  readBytesBounded,
  serializeRequestBody,
} from "./body-reader.js"
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  type HeraHttpError,
  makeNetworkHttpError,
  makePayloadTooLargeHttpError,
  makeRateLimitedHttpError,
  makeStatusHttpError,
  makeTimeoutHttpError,
  type RateLimitedError,
} from "./errors.js"
import { extractBodyRetryAfter, parseRetryAfter } from "./retry-after.js"

const TIMEOUT_REASON = Symbol.for("@sibylline-labs/hera/HeraHttpTimeout")

/** A completed 2xx exchange, or a 3xx under `redirect: "manual"` (body unread, empty). */
export interface HeraHttpExchange {
  readonly url: string
  readonly method: HttpMethod
  readonly res: Response
  readonly body: BoundedBytesResult
}

const EMPTY_BODY: BoundedBytesResult = {
  bytes: new Uint8Array(0),
  truncated: false,
  byteLength: 0,
}

/**
 * The whole-exchange core shared by `HeraHttp.request` and `HeraHttp.requestBytes`:
 * one `AbortController` timeout spanning connect, headers, the bounded body read and
 * `finish`; a declared-length pre-check; `429` → `RateLimitedError` (never auto-retried);
 * non-2xx → `HttpStatusError`. Under `redirect: "manual"` a 3xx skips all of that and
 * reaches `finish` with an empty body, so the caller can re-check `location`.
 */
export function exchange<A>(
  options: HeraHttpRequestOptions<never>,
  finish: (
    exchanged: HeraHttpExchange
  ) => Effect.Effect<A, RateLimitedError | HeraHttpError>
): Effect.Effect<A, RateLimitedError | HeraHttpError> {
  const method: HttpMethod = options.method ?? "GET"
  const url = options.url
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const onMaxBytes = options.onMaxBytes ?? "fail"
  const fetchImpl = options.fetch ?? globalThis.fetch
  const nowFn = options.nowMs ?? Date.now

  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(TIMEOUT_REASON)
      }, timeoutMs)
      return {
        controller,
        isTimedOut: () =>
          timedOut || controller.signal.reason === TIMEOUT_REASON,
        cleanup: () => {
          clearTimeout(timer)
          if (!controller.signal.aborted) {
            controller.abort()
          }
        },
      }
    }),
    (state) =>
      Effect.gen(function* () {
        const { serialized, isJson } = serializeRequestBody(options.body)
        const headers = buildRequestHeaders(options.headers, isJson)
        const cancelBody = (res: Response) =>
          Effect.promise(
            () => res.body?.cancel().catch(() => undefined) ?? Promise.resolve()
          )

        const res = yield* Effect.tryPromise({
          try: () =>
            fetchImpl(url, {
              method,
              headers,
              ...(serialized !== undefined ? { body: serialized } : {}),
              ...(options.redirect !== undefined
                ? { redirect: options.redirect }
                : {}),
              signal: state.controller.signal,
            }),
          catch: (cause) =>
            state.isTimedOut()
              ? makeTimeoutHttpError(url, method, timeoutMs)
              : makeNetworkHttpError(url, method, cause),
        })

        if (
          options.redirect === "manual" &&
          res.status >= 300 &&
          res.status < 400
        ) {
          yield* cancelBody(res)
          return yield* finish({ url, method, res, body: EMPTY_BODY })
        }

        const contentLengthHeader = res.headers.get("content-length")
        if (onMaxBytes === "fail" && contentLengthHeader !== null) {
          const declaredBytes = Number(contentLengthHeader)
          if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
            yield* cancelBody(res)
            return yield* makePayloadTooLargeHttpError(
              url,
              method,
              res.status,
              maxBytes
            )
          }
        }

        const body = yield* Effect.tryPromise({
          try: () =>
            readBytesBounded(res.body, maxBytes, state.controller.signal),
          catch: (cause) =>
            state.isTimedOut()
              ? makeTimeoutHttpError(url, method, timeoutMs)
              : makeNetworkHttpError(url, method, cause, res.status),
        })
        const text = () => new TextDecoder().decode(body.bytes)

        if (res.status === 429) {
          const nowMs = nowFn()
          const fromHeader = parseRetryAfter(
            res.headers.get("retry-after"),
            nowMs
          )
          const resolved =
            fromHeader.retryAfterSeconds !== null
              ? fromHeader
              : extractBodyRetryAfter(text(), nowMs)
          return yield* makeRateLimitedHttpError(url, method, resolved, text())
        }

        if (body.truncated && onMaxBytes === "fail") {
          return yield* makePayloadTooLargeHttpError(
            url,
            method,
            res.status,
            maxBytes,
            text()
          )
        }

        if (res.status < 200 || res.status >= 300) {
          return yield* makeStatusHttpError(url, method, res.status, text())
        }

        return yield* finish({ url, method, res, body })
      }),
    (state) => Effect.sync(() => state.cleanup())
  )
}
