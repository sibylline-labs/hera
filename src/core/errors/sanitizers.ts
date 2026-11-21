export const SECRET_FIELD_KEY =
  /token|secret|key|authorization|password|cookie|credential/i

export const RESERVED_ENVELOPE_KEYS = new Set([
  "type",
  "title",
  "detail",
  "instance",
  "_tag",
  "ok",
  "error",
  "code",
  "status",
  "httpStatus",
  "message",
  "publicMessage",
  "request_id",
  "requestId",
  "retry_after",
  "retryAfter",
  "issues",
  "fields",
  "cause",
  "stack",
  "name",
])

/**
 * Strips sensitive keys, `Error` instances, functions, and symbols from structured
 * error fields so raw secrets or exception messages can never leak into wire payloads.
 */
export function sanitizeErrorFields(
  raw: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> | undefined {
  if (raw === undefined) {
    return undefined
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (
      k === "_tag" ||
      k === "cause" ||
      k === "stack" ||
      k === "message" ||
      k === "publicMessage"
    ) {
      continue
    }
    if (SECRET_FIELD_KEY.test(k)) {
      out[k] = "[REDACTED]"
      continue
    }
    if (
      v instanceof Error ||
      typeof v === "function" ||
      typeof v === "symbol" ||
      v === undefined
    ) {
      continue
    }
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}
