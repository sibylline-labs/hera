import { HeraError } from "../../core/errors/index.js"
import type { RequestId } from "../../core/schema/index.js"
import { resolveRequestId } from "./headers.js"

/**
 * The router's `404 route_not_found` as `application/problem+json`, carrying `X-Request-Id`.
 */
export function routeNotFoundResponse(
  request: Request,
  requestId?: RequestId | string
): Response {
  const id = resolveRequestId(request, requestId)
  return HeraError.toResponse(
    HeraError.notFound("Route not found", {
      code: "route_not_found",
      requestId: id,
    })
  )
}

/**
 * The router's `405 method_not_allowed` as `application/problem+json`, with `Allow` naming every
 * method the matched path takes (RFC 9110 §15.5.6).
 */
export function methodNotAllowedResponse(
  request: Request,
  allow: ReadonlyArray<string>,
  requestId?: RequestId | string
): Response {
  const id = resolveRequestId(request, requestId)
  return HeraError.toResponse(
    HeraError.methodNotAllowed(undefined, { requestId: id }),
    { headers: { allow: allow.join(", ") } }
  )
}
