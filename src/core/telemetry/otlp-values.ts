import { isSecretKey, scrubLogString, scrubLogValue } from "../logger/redaction.js"
import { REDACTED_VALUE, type ScrubRules } from "../logger/types.js"

/** An OTLP/JSON `AnyValue`. */
export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly arrayValue: { readonly values: ReadonlyArray<OtlpAnyValue> } }

export interface OtlpKeyValue {
  readonly key: string
  readonly value: OtlpAnyValue
}

const MAX_STRING = 4_096

function scrubbed(text: string, rules: ScrubRules): OtlpAnyValue {
  return { stringValue: scrubLogString(text, rules).slice(0, MAX_STRING) }
}

/** `value` as an OTLP `AnyValue`, every string scrubbed; `undefined` for a value that cannot export. */
export function toAnyValue(value: unknown, rules: ScrubRules): OtlpAnyValue | undefined {
  if (typeof value === "string") return scrubbed(value, rules)
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "bigint") return { intValue: value.toString() }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
    const values = value.map((item) => toAnyValue(item, rules)).filter((item) => item !== undefined)
    return { arrayValue: { values } }
  }
  if (value === null || value === undefined || typeof value === "function" || typeof value === "symbol") return undefined
  try {
    return scrubbed(JSON.stringify(scrubLogValue(value, rules)) ?? "", rules)
  } catch {
    return undefined
  }
}

/** A record's entries as OTLP attributes: secret keys redacted, every string scrubbed. */
export function toAttributes(
  record: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>,
  rules: ScrubRules
): Array<OtlpKeyValue> {
  const entries = record instanceof Map ? [...record.entries()] : Object.entries(record)
  const out: Array<OtlpKeyValue> = []
  for (const [rawKey, raw] of entries) {
    const key = scrubLogString(String(rawKey), rules)
    const textual = typeof raw === "string" || (Array.isArray(raw) && raw.some((item) => typeof item === "string"))
    const value = textual && isSecretKey(String(rawKey), rules) ? { stringValue: REDACTED_VALUE } : toAnyValue(raw, rules)
    if (value !== undefined) out.push({ key, value })
  }
  return out
}

/** Unix milliseconds (or a bigint of nanoseconds) as the decimal string OTLP/JSON carries. */
export function unixNano(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString()
}
