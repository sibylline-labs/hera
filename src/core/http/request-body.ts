/**
 * The one capped request-body reader: the route boundary's `maxBodyBytes` / `bodyFormat` path and a
 * handler's `HeraHttp.readBody` both run it.
 *
 * Invariants:
 *  - The cap runs before any decode: a declared `content-length` over `maxBytes` is refused
 *    before a byte is read, and the stream is read only up to the cap. The streamed check is the
 *    bound (workerd may hide `content-length`); the declared one is a shortcut.
 *  - With no `maxBytes` the read is `request.text()` (a route with no cap, unchanged).
 *  - A form body is decoded only on `format: "json-or-form"`; every other read parses JSON
 *    whatever the `content-type`, so a form body there is `malformed`.
 *  - Every refusal is a typed `HeraBodyReadError`; the reader writes no response.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readBytesBounded } from "./body-reader.js"

const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded"

/** `json` parses JSON whatever the `content-type`; `json-or-form` also decodes a form body. */
export type HeraBodyFormat = "json" | "json-or-form"

export interface HeraReadBodyOptions {
  /** The byte cap, a positive integer: declared, then streamed. */
  readonly maxBytes: number
  readonly format: HeraBodyFormat
}

export const HeraBodyReadErrorReasonSchema = Schema.Literals(["too_large", "malformed"])
export type HeraBodyReadErrorReason = typeof HeraBodyReadErrorReasonSchema.Type

/**
 * A request body refused by the capped reader: `too_large` (over the cap, declared or streamed) or
 * `malformed` (not JSON, empty, not an object for `readBody`, or a stream that failed). The caller
 * maps it to its own wire error.
 */
export class HeraBodyReadError extends Schema.TaggedError<HeraBodyReadError>()(
  "HeraBodyReadError",
  { reason: HeraBodyReadErrorReasonSchema }
) {
  override get message(): string {
    return this.reason === "too_large"
      ? "Request body is over the byte cap"
      : "Request body is malformed"
  }
}

const tooLarge = () => new HeraBodyReadError({ reason: "too_large" })
const malformed = () => new HeraBodyReadError({ reason: "malformed" })

/** Whether the declared `content-length` is over the cap. */
export function declaredOverCap(request: Request, maxBytes: number): boolean {
  const declared = request.headers.get("content-length")
  return declared !== null && Number(declared) > maxBytes
}

function mediaTypeOf(request: Request): string {
  const header = request.headers.get("content-type") ?? ""
  return (header.split(";")[0] ?? "").trim().toLowerCase()
}

function readText(
  request: Request,
  maxBytes: number | undefined
): Effect.Effect<string, HeraBodyReadError, never> {
  if (maxBytes === undefined) {
    return Effect.tryPromise({ try: () => request.text(), catch: malformed })
  }
  if (declaredOverCap(request, maxBytes)) return Effect.fail(tooLarge())
  return Effect.flatMap(
    Effect.tryPromise({
      try: () => readBytesBounded(request.body, maxBytes),
      catch: malformed,
    }),
    (read) =>
      read.truncated
        ? Effect.fail(tooLarge())
        : Effect.succeed(new TextDecoder().decode(read.bytes))
  )
}

function parseJson(text: string): Effect.Effect<unknown, HeraBodyReadError, never> {
  return Effect.try({
    try: () => {
      if (text.trim().length === 0) throw new Error("EMPTY_JSON_BODY")
      return JSON.parse(text) as unknown
    },
    catch: malformed,
  })
}

/**
 * Reads the body (capped when `maxBytes` is set) as its decoded value: a flat string record for a
 * form body under `json-or-form`, else parsed JSON of any shape.
 */
export function readRequestValue(
  request: Request,
  options: { readonly maxBytes?: number | undefined; readonly format: HeraBodyFormat }
): Effect.Effect<unknown, HeraBodyReadError, never> {
  return Effect.gen(function* () {
    const text = yield* readText(request, options.maxBytes)
    if (options.format === "json-or-form" && mediaTypeOf(request) === FORM_MEDIA_TYPE) {
      return Object.fromEntries(new URLSearchParams(text)) as unknown
    }
    return yield* parseJson(text)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A handler's capped body read, run after the handler's own pre-body gates: the body as a flat
 * record, or a `HeraBodyReadError` the caller maps to its own wire. JSON that is not an object (an
 * array, a scalar, `null`) is `malformed`. A `maxBytes` that is not a positive integer is a defect.
 */
export function readBody(
  request: Request,
  options: HeraReadBodyOptions
): Effect.Effect<Record<string, unknown>, HeraBodyReadError, never> {
  if (!(Number.isInteger(options.maxBytes) && options.maxBytes > 0)) {
    return Effect.die(new Error("HeraHttp.readBody: maxBytes must be a positive integer"))
  }
  return Effect.flatMap(readRequestValue(request, options), (value) =>
    isRecord(value) ? Effect.succeed(value) : Effect.fail(malformed())
  )
}
