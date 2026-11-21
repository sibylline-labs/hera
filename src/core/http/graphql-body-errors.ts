import type { HeraGraphqlErrorEntry } from "./errors.js"
import { extractGraphqlErrors } from "./graphql-errors.js"

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * The bounded `errors[]` entries a non-2xx body carries (Linear answers `RATELIMITED` with a 400
 * and the GraphQL reply as the body), or `null` when the body is not a JSON object with a
 * non-empty `errors` list. Unlike a 2xx, a non-list `errors` adds nothing: the status already
 * reports the failure.
 */
export function graphqlErrorsInBody(
  body: string
): ReadonlyArray<HeraGraphqlErrorEntry> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.errors)) {
    return null
  }
  return extractGraphqlErrors(parsed.errors)
}
