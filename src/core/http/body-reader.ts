import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import { DEFAULT_MAX_RESPONSE_BYTES } from "./errors.js"

/**
 * Result of reading an HTTP response stream with a strict byte ceiling.
 */
export interface BoundedBodyResult {
  readonly text: string
  readonly truncated: boolean
  readonly byteLength: number
}

/**
 * Result of reading an HTTP response stream as raw bytes with a strict byte ceiling.
 */
export interface BoundedBytesResult {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly truncated: boolean
  readonly byteLength: number
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"

export type HttpHeaderValue = string | Redacted.Redacted<string>

export interface HeraHttpRequestOptions<
  S extends Schema.Top | undefined = undefined,
> {
  readonly url: string
  readonly method?: HttpMethod | undefined
  readonly headers?:
    | Readonly<Record<string, HttpHeaderValue | undefined>>
    | Headers
    | undefined
  readonly body?:
    | string
    | Uint8Array
    | Readonly<Record<string, unknown>>
    | undefined
  readonly schema?: S | undefined
  readonly timeoutMs?: number | undefined
  readonly maxBytes?: number | undefined
  readonly onMaxBytes?: "fail" | "truncate" | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly nowMs?: (() => number) | undefined
  /**
   * Passed to `fetch`. Under `"manual"` a 3xx resolves as a response (body cancelled
   * unread, empty `text`/`bytes`) so the caller can read `location` and re-check it.
   */
  readonly redirect?: "follow" | "manual" | "error" | undefined
}

export interface HeraHttpResponse<T = string> {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  readonly truncated: boolean
  readonly byteLength: number
  readonly data: T
}

/**
 * Response of `HeraHttp.requestBytes`: the body as exact bytes, never decoded as text.
 */
export interface HeraHttpBytesResponse {
  readonly status: number
  readonly headers: Headers
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly truncated: boolean
  readonly byteLength: number
}

export type HeraHttpBytesRequestOptions = Omit<
  HeraHttpRequestOptions<undefined>,
  "schema"
>

export type HeraHttpMethodShorthandOptions<
  S extends Schema.Top | undefined = undefined,
> = Omit<HeraHttpRequestOptions<S>, "url" | "method">

/**
 * Reads a `ReadableStream<Uint8Array>` as raw bytes up to `maxBytes` (default `64 KiB`).
 *
 * When the stream exceeds `maxBytes`, cancels the underlying stream immediately
 * so an unbounded upstream body cannot exhaust memory or hold the socket open.
 */
export async function readBytesBounded(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
  signal?: AbortSignal
): Promise<BoundedBytesResult> {
  if (!body) {
    return { bytes: new Uint8Array(0), truncated: false, byteLength: 0 }
  }
  if (signal?.aborted) {
    throw (
      signal.reason ??
      new DOMException("The operation was aborted.", "AbortError")
    )
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let truncated = false

  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    while (true) {
      if (signal?.aborted) {
        throw (
          signal.reason ??
          new DOMException("The operation was aborted.", "AbortError")
        )
      }
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!value || value.byteLength === 0) {
        continue
      }
      if (totalBytes + value.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - totalBytes)
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining))
          totalBytes += remaining
        }
        truncated = true
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(value)
      totalBytes += value.byteLength
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    try {
      reader.releaseLock()
    } catch {
      // Lock may already be released on cancel/abort
    }
  }

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { bytes: merged, truncated, byteLength: totalBytes }
}

/**
 * Reads a `ReadableStream<Uint8Array>` up to `maxBytes` and decodes it as UTF-8 text.
 */
export async function readTextBounded(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
  signal?: AbortSignal
): Promise<BoundedBodyResult> {
  const { bytes, truncated, byteLength } = await readBytesBounded(
    body,
    maxBytes,
    signal
  )
  return { text: new TextDecoder().decode(bytes), truncated, byteLength }
}

export function buildRequestHeaders(
  input:
    | Readonly<Record<string, HttpHeaderValue | undefined>>
    | Headers
    | undefined,
  hasJsonBody: boolean
): Headers {
  const headers = new Headers()
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      headers.set(key, value)
    })
  } else if (input !== undefined) {
    for (const [key, rawVal] of Object.entries(input)) {
      if (rawVal === undefined) {
        continue
      }
      const resolved = Redacted.isRedacted(rawVal)
        ? Redacted.value(rawVal)
        : rawVal
      headers.set(key, resolved)
    }
  }
  if (hasJsonBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8")
  }
  return headers
}

export function serializeRequestBody(
  body: string | Uint8Array | Readonly<Record<string, unknown>> | undefined
): { readonly serialized: BodyInit | undefined; readonly isJson: boolean } {
  if (body === undefined) {
    return { serialized: undefined, isJson: false }
  }
  if (typeof body === "string") {
    return { serialized: body, isJson: false }
  }
  if (body instanceof Uint8Array) {
    return { serialized: body as unknown as BodyInit, isJson: false }
  }
  return { serialized: JSON.stringify(body), isJson: true }
}
