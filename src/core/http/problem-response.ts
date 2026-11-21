import { HeraError } from "../errors/index.js"
import { type HeraSchemaError, isHeraSchemaError } from "../schema/index.js"

/**
 * Converts a `HeraError` or `HeraSchemaError` into the same RFC 7807 `application/problem+json`
 * `Response` that `HeraError.toResponse` produces. `init.headers` are merged over the closed
 * headers; the status always comes from the error.
 */
export function toProblemResponse(
  error: HeraError | HeraSchemaError,
  init?: ResponseInit
): Response {
  const heraError = isHeraSchemaError(error)
    ? HeraError.fromSchemaError(error)
    : error
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value
  })
  return HeraError.toResponse(heraError, { headers })
}
