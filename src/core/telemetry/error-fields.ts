/** Most fields one failed span exports. */
export const MAX_ERROR_FIELDS = 8

/** A field name that is a plain identifier, so it can sit under the `error.field.` attribute prefix. */
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
/** Longest string value a span exports. */
const MAX_VALUE_LENGTH = 48
/** Longest run of letters in one word of a code; a longer run reads as an opaque token, not a word. */
const MAX_WORD_LENGTH = 20
/** A code: letter words joined by `_ . : -`, with at most 4-digit number words (`linear_rate_limited`, `HTTP_429`). */
const CODE_VALUE = /^[A-Za-z]+(?:[_.:-](?:[A-Za-z]+|[0-9]{1,4}))*$/

function isCodeShaped(value: string, rules: RedactionRules): boolean {
  if (value.length > MAX_VALUE_LENGTH || !CODE_VALUE.test(value)) return false
  if (!value.split(/[_.:-]/).every((word) => word.length <= MAX_WORD_LENGTH)) return false
  return scrubLogString(value, rules) === value
}

import { scrubLogString } from "../logger/redaction.js"
import type { RedactionRules } from "../logger/types.js"

export type ErrorFieldValue = string | number | boolean

/**
 * The fields of a failed `HeraError` a span may export: only code-shaped strings, finite numbers and
 * booleans under identifier keys, capped at `MAX_ERROR_FIELDS`. A free-text value is dropped whole, so
 * an upstream's own words never reach telemetry through a field. A value the logger's scrubber would alter
 * (Hera's credential shapes and the consumer's `secretShapes`) is dropped too.
 */
export function exportableErrorFields(error: object, rules: RedactionRules): Readonly<Record<string, ErrorFieldValue>> | undefined {
  const raw: unknown = Reflect.get(error, "fields")
  if (typeof raw !== "object" || raw === null) return undefined
  const out: Record<string, ErrorFieldValue> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_ERROR_FIELDS) break
    if (!FIELD_KEY.test(key)) continue
    if (typeof value === "string" ? isCodeShaped(value, rules) : typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}
