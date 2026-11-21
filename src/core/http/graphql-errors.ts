import type { HeraGraphqlErrorEntry } from "./errors.js"

/** At most this many `errors[]` entries are kept on a `GraphqlError`. */
export const MAX_GRAPHQL_ERRORS = 20

/** Each kept entry's `message` is cut to this many characters. */
export const MAX_GRAPHQL_ERROR_MESSAGE_CHARS = 500

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

function toEntry(raw: unknown): HeraGraphqlErrorEntry {
  if (!isRecord(raw)) {
    return { message: "(no message)" }
  }
  const message =
    typeof raw.message === "string"
      ? raw.message.slice(0, MAX_GRAPHQL_ERROR_MESSAGE_CHARS)
      : "(no message)"
  const path =
    Array.isArray(raw.path) &&
    raw.path.every((p) => typeof p === "string" || typeof p === "number")
      ? (raw.path as ReadonlyArray<string | number>)
      : undefined
  const code = isRecord(raw.extensions) ? raw.extensions.code : undefined
  return {
    message,
    ...(path !== undefined ? { path } : {}),
    ...(typeof code === "string" ? { code } : {}),
  }
}

/**
 * The bounded entries of a GraphQL reply's `errors` member, or `null` when it reports none
 * (absent, `null` or `[]`). An `errors` that is present but not a list is itself an error report:
 * the payload cannot be trusted, so it is never read as success.
 */
export function extractGraphqlErrors(
  errors: unknown
): ReadonlyArray<HeraGraphqlErrorEntry> | null {
  if (errors === undefined || errors === null) {
    return null
  }
  if (!Array.isArray(errors)) {
    return [{ message: "(errors is not a list)" }]
  }
  if (errors.length === 0) {
    return null
  }
  return errors.slice(0, MAX_GRAPHQL_ERRORS).map(toEntry)
}
