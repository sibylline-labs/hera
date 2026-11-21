/**
 * The route boundary's request-body read: the core capped reader (`readRequestValue`, the one
 * `HeraHttp.readBody` runs) with its refusals mapped onto the route wire — `too_large` is
 * `413 payload_too_large`, `malformed` is `400 invalid_json`.
 */
import * as Effect from "effect/Effect"
import { HeraError } from "../../core/errors/index.js"
import {
  declaredOverCap,
  type HeraBodyReadError,
  readRequestValue,
} from "../../core/http/request-body.js"
import type { RequestId } from "../../core/schema/index.js"
import type { HeraRouteBodyOptions } from "./types.js"

function invalidJson(requestId: RequestId): HeraError {
  return new HeraError({
    code: "invalid_json",
    httpStatus: 400,
    publicMessage: "Malformed JSON request body",
    requestId,
  })
}

function tooLarge(requestId: RequestId): HeraError {
  return HeraError.payloadTooLarge(undefined, {
    code: "payload_too_large",
    requestId,
  })
}

/** Throws at route construction when `maxBodyBytes` is set but is not a positive integer. */
export function assertRouteBodyOptions(
  options: HeraRouteBodyOptions,
  builder: "publicRoute" | "authedRoute"
): void {
  const max = options.maxBodyBytes
  if (max !== undefined && !(Number.isInteger(max) && max > 0)) {
    throw new Error(`Hera.${builder}: maxBodyBytes must be a positive integer`)
  }
}

/** Fails `413 payload_too_large` when the declared `content-length` is over the cap. */
export function refuseDeclaredOversize(
  request: Request,
  maxBodyBytes: number,
  requestId: RequestId
): Effect.Effect<void, HeraError, never> {
  return declaredOverCap(request, maxBodyBytes)
    ? Effect.fail(tooLarge(requestId))
    : Effect.void
}

/**
 * Reads the route's body (capped when `maxBodyBytes` is set) and returns the value its `body`
 * schema decodes: a flat string record for an opted-in form body, else parsed JSON.
 */
export function readRouteBody(
  request: Request,
  options: HeraRouteBodyOptions,
  requestId: RequestId
): Effect.Effect<unknown, HeraError, never> {
  return Effect.mapError(
    readRequestValue(request, {
      maxBytes: options.maxBodyBytes,
      format: options.bodyFormat ?? "json",
    }),
    (error: HeraBodyReadError) =>
      error.reason === "too_large" ? tooLarge(requestId) : invalidJson(requestId)
  )
}
