import { GITLEAKS_SHAPES } from "../../core/logger/gitleaks.js"
import { scrubLogString } from "../../core/logger/redaction.js"

const REDACTED_MARK = "[REDACTED]"
const RULES = { secretShapes: GITLEAKS_SHAPES }
/** Deeper field values are dropped rather than walked: verifier errors carry flat fields. */
const MAX_DEPTH = 8

/**
 * Redacts text an authority verifier built: the exact held credential first, on the raw text,
 * then Hera's credential-shape scrub (Bearer, `sib_`/`sk_` keys, gitleaks shapes) for any other
 * credential the verifier echoed. The exact pass runs first because a shape scrub can rewrite part
 * of an opaque credential so that an exact match no longer finds it.
 */
export function cleanAuthorityText(text: string, secret: string): string {
  return scrubLogString(text.split(secret).join(REDACTED_MARK), RULES)
}

/** True when `text` holds the credential or a credential shape, so it cannot be shown at all. */
export function isUnsafeAuthorityText(text: string, secret: string): boolean {
  return cleanAuthorityText(text, secret) !== text
}

function cleanValue(value: unknown, secret: string, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return cleanAuthorityText(value, secret)
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value !== "object" || depth >= MAX_DEPTH || seen.has(value)) return undefined
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => cleanValue(item, secret, seen, depth + 1)).filter((item) => item !== undefined)
  }
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (isUnsafeAuthorityText(key, secret)) continue
    const cleaned = cleanValue(inner, secret, seen, depth + 1)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

/**
 * Redacts every string in an error's fields, keys included, by walking the values: no JSON round
 * trip, so a credential with JSON-escaped characters is still matched and a value that cannot be
 * serialised (a cycle, a bigint, a function) is dropped instead of throwing.
 */
export function cleanAuthorityFields(
  fields: Readonly<Record<string, unknown>> | undefined,
  secret: string
): Readonly<Record<string, unknown>> | undefined {
  if (fields === undefined) return undefined
  return cleanValue(fields, secret, new WeakSet(), 0) as Readonly<Record<string, unknown>>
}
