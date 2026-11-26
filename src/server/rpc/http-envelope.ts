/**
 * HTTP carried over Workers JS RPC as plain structured-clone values.
 *
 * A `Request` or `Response` with a body crosses a Service Binding as a stream plus a
 * `StreamCanceler` capability; workerd can then cancel the callee as hung after it already
 * answered, killing its `waitUntil` work (cloudflare/workerd#8674). An envelope carries no stream.
 *
 * Invariants:
 *  - An envelope holds exactly the `url` / `method` / `status`, every header pair in order
 *    (each `set-cookie` its own pair) and the whole body as an `ArrayBuffer`, or `null` when there
 *    is none (`GET` / `HEAD`, a null-body status, or no body).
 *  - A body over `maxBytes` is refused with a `HeraError` before more than `maxBytes` plus one
 *    chunk is read; a declared `content-length` over the cap is refused before any read.
 *  - The `from*` readers take the raw Web value or the envelope, so either side can deploy first.
 */
import { HeraError } from "../../core/errors/index.js"
import { readBytesBounded } from "../../core/http/body-reader.js"
import { declaredOverCap } from "../../core/http/request-body.js"

/** A `Request` as a structured-clone value. */
export interface HttpRpcRequest {
  readonly url: string
  readonly method: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: ArrayBuffer | null
}

/** A `Response` as a structured-clone value. */
export interface HttpRpcReply {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: ArrayBuffer | null
}

export interface HttpRpcBodyOptions {
  /** Byte cap for the body: an integer from 1 to `MAX_JS_RPC_MESSAGE_BYTES`. */
  readonly maxBytes?: number | undefined
}

/** Default body cap: 25 MiB, leaving headroom below the transport's message limit. */
export const MAX_HTTP_RPC_BYTES = 25 * 1024 * 1024

/** workerd's `MAX_JS_RPC_MESSAGE_SIZE`: no envelope larger than this can cross RPC. */
export const MAX_JS_RPC_MESSAGE_BYTES = 32 * 1024 * 1024

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304])

/** The cap to apply; a cap the transport could never carry is a defect, not a refusal. */
export function resolveHttpRpcMaxBytes(options: HttpRpcBodyOptions | undefined): number {
  const maxBytes = options?.maxBytes ?? MAX_HTTP_RPC_BYTES
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_JS_RPC_MESSAGE_BYTES) {
    throw new RangeError(`maxBytes must be an integer from 1 to ${MAX_JS_RPC_MESSAGE_BYTES}`)
  }
  return maxBytes
}

function isHeaderPairs(u: unknown): u is ReadonlyArray<readonly [string, string]> {
  return (
    Array.isArray(u) &&
    u.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string"
    )
  )
}

function isBody(u: unknown): u is ArrayBuffer | null {
  return u === null || u instanceof ArrayBuffer
}

/** Whether `u` is an `HttpRpcRequest` envelope. */
export function isHttpRpcRequest(u: unknown): u is HttpRpcRequest {
  if (typeof u !== "object" || u === null || u instanceof Request) return false
  const r = u as Record<string, unknown>
  return (
    typeof r.url === "string" &&
    typeof r.method === "string" &&
    isHeaderPairs(r.headers) &&
    isBody(r.body)
  )
}

/** Whether `u` is an `HttpRpcReply` envelope. */
export function isHttpRpcReply(u: unknown): u is HttpRpcReply {
  if (typeof u !== "object" || u === null || u instanceof Response) return false
  const r = u as Record<string, unknown>
  return typeof r.status === "number" && isHeaderPairs(r.headers) && isBody(r.body)
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = bytes.buffer as ArrayBuffer
  return bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength
    ? buffer
    : buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** Reads `body` whole up to `maxBytes`; `null` when it is over the cap. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<ArrayBuffer | null> {
  const read = await readBytesBounded(body, maxBytes)
  return read.truncated ? null : exactBuffer(read.bytes)
}

/**
 * `request` as an `HttpRpcRequest`, its body read whole up to `maxBytes` (default
 * `MAX_HTTP_RPC_BYTES`). Rejects with a 413 `payload_too_large` `HeraError` when the declared
 * `content-length` or the streamed body is over the cap.
 */
export async function toHttpRpcRequest(
  request: Request,
  options?: HttpRpcBodyOptions
): Promise<HttpRpcRequest> {
  const maxBytes = resolveHttpRpcMaxBytes(options)
  const method = request.method.toUpperCase()
  let body: ArrayBuffer | null = null
  if (request.body !== null && method !== "GET" && method !== "HEAD") {
    if (declaredOverCap(request, maxBytes)) {
      void request.body.cancel().catch(() => {})
      throw HeraError.payloadTooLarge(undefined, { fields: { maxBytes } })
    }
    body = await readCapped(request.body, maxBytes)
    if (body === null) throw HeraError.payloadTooLarge(undefined, { fields: { maxBytes } })
  }
  return { url: request.url, method: request.method, headers: [...request.headers], body }
}

/** The incoming request as a `Request`: a `Request` as is, an envelope rebuilt. Anything else is a 400. */
export function fromHttpRpcRequest(input: Request | HttpRpcRequest): Request {
  if (input instanceof Request) return input
  if (!isHttpRpcRequest(input)) {
    throw new HeraError({
      code: "invalid_rpc_input",
      httpStatus: 400,
      publicMessage: "Invalid RPC input payload",
    })
  }
  return new Request(input.url, {
    method: input.method,
    headers: input.headers.map(([name, value]): [string, string] => [name, value]),
    ...(input.body === null ? {} : { body: input.body }),
  })
}

/**
 * `response` as an `HttpRpcReply`, its body read whole up to `maxBytes` (default
 * `MAX_HTTP_RPC_BYTES`). Rejects with a 502 `bad_gateway` `HeraError` when the body is over the
 * cap: the caller could not carry it.
 */
export async function toHttpRpcReply(
  response: Response,
  options?: HttpRpcBodyOptions
): Promise<HttpRpcReply> {
  const maxBytes = resolveHttpRpcMaxBytes(options)
  let body: ArrayBuffer | null = null
  if (response.body !== null && !NULL_BODY_STATUSES.has(response.status)) {
    body = await readCapped(response.body, maxBytes)
    if (body === null) {
      throw HeraError.badGateway(undefined, { fields: { maxBytes, reason: "reply_too_large" } })
    }
  }
  return { status: response.status, headers: [...response.headers], body }
}

/** The reply as a `Response`: a `Response` as is, an envelope rebuilt. Anything else is a 502. */
export function fromHttpRpcReply(reply: Response | HttpRpcReply): Response {
  if (reply instanceof Response) return reply
  if (!isHttpRpcReply(reply)) {
    throw HeraError.badGateway(undefined, { fields: { reason: "unrecognised_reply" } })
  }
  const body = NULL_BODY_STATUSES.has(reply.status) ? null : reply.body
  return new Response(body, {
    status: reply.status,
    headers: reply.headers.map(([name, value]): [string, string] => [name, value]),
  })
}
