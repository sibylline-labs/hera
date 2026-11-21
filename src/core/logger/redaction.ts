import * as Redacted from "effect/Redacted"
import { scrubCredentialRuns } from "./shapes.js"
import {
  CIRCULAR_VALUE,
  DEFAULT_ERROR_CODES,
  ERROR_MESSAGE_LIMIT,
  HERA_ERROR_TAGS,
  type HeraErrorTag,
  MAX_SCRUB_DEPTH,
  REDACTED_VALUE,
  type RedactionRules,
  type ScrubbedError,
  type ScrubOptions,
  type ScrubRules,
  TRUNCATED_VALUE,
} from "./types.js"

/**
 * Matches credential-shaped keys such as `authorization`, `api_key`, `apiKey`,
 * `secret`, `token`, `key_hash`, `keyHash`, `password`, `cookie`, `private_key`, etc.
 */
export const SECRET_KEY_PATTERN =
  /(?:^|[_-])(?:authorization|token|secret|password|passwd|cookie|credential|bearer)s?(?:$|[_-])|api[_-]?key|key[_-]?hash|private[_-]?key|client[_-]?secret|access[_-]?key|signing[_-]?key|session[_-]?key|(?:Authorization|Token|Secret|Password|Cookie|Credential|ApiKey|KeyHash|PrivateKey|ClientSecret|AccessKey|SigningKey|SessionKey)$/i

/**
 * Matches raw bearer credentials and API key prefixes (`Bearer ...`, `ol_live_*`,
 * `ol_test_*`, `sib_live_*`, `sib_test_*`, `sk_live_*`, `sk_test_*`, and
 * `sib_<26-char ULID>_<secret>` bearer tokens).
 */
export const SECRET_STRING_PATTERN =
  /\bBearer\s+\S+|\b(?:ol|sib|sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]*|\bsib_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]+|\b(?:ol|sib)_(?:live|test)\b/i

const NO_RULES: RedactionRules = {}

function matchesKey(pattern: RegExp | undefined, key: string): boolean {
  if (pattern === undefined) {
    return false
  }
  // A `g`/`y` pattern's `test` is stateful (`lastIndex`); reset it so every key is tested whole.
  pattern.lastIndex = 0
  return pattern.test(key)
}

/** True when `key` names a credential by Hera's list or the consumer's `rules.secretKeys`. */
export function isSecretKey(key: string, rules: RedactionRules = NO_RULES): boolean {
  return SECRET_KEY_PATTERN.test(key) || matchesKey(rules.secretKeys, key)
}

export function isSecretString(value: string): boolean {
  return SECRET_STRING_PATTERN.test(value)
}

/**
 * Credential-shaped runs (Hera's and `rules.secretShapes`) are replaced in place; a string that
 * still matches {@link SECRET_STRING_PATTERN} afterwards is replaced whole.
 */
export function scrubLogString(
  value: string,
  rules: RedactionRules = NO_RULES
): string {
  const scrubbed = scrubCredentialRuns(value, rules.secretShapes)
  if (isSecretString(scrubbed)) {
    return REDACTED_VALUE
  }
  return scrubbed
}

/** An error's text as written in `"scrubbed"` mode: scrubbed first, then cut, so no partial credential survives. */
function boundErrorMessage(raw: string, rules: ScrubRules): string {
  return scrubLogString(raw, rules).slice(0, ERROR_MESSAGE_LIMIT)
}

export function isHeraErrorTag(tag: unknown): tag is HeraErrorTag {
  return typeof tag === "string" && HERA_ERROR_TAGS.has(tag as HeraErrorTag)
}

export function isErrorLike(value: object): boolean {
  if (value instanceof Error) {
    return true
  }
  const tag = Reflect.get(value, "_tag")
  if (isHeraErrorTag(tag)) {
    return true
  }
  return (
    typeof tag === "string" &&
    tag.endsWith("Error") &&
    typeof Reflect.get(value, "message") === "string"
  )
}

export function normalizeWhitelist(
  input?: ReadonlySet<string> | ReadonlyArray<string> | undefined
): ReadonlySet<string> {
  if (!input) {
    return new Set()
  }
  if (input instanceof Set) {
    return input
  }
  return new Set(input)
}

function scrubErrorInstance(
  err: object,
  whitelist: ReadonlySet<string>,
  depth: number,
  seen: WeakSet<object>,
  rules: ScrubRules
): ScrubbedError {
  const rawTag = Reflect.get(err, "_tag")
  const tag = typeof rawTag === "string" ? rawTag : undefined
  const rawName = Reflect.get(err, "name")
  const name =
    typeof rawName === "string" && rawName.length > 0
      ? scrubLogString(rawName, rules)
      : scrubLogString(tag ?? "Error", rules)

  const rawCode = Reflect.get(err, "code") ?? Reflect.get(err, "errorCode")
  const code =
    typeof rawCode === "string" &&
    rawCode.length > 0 &&
    scrubLogString(rawCode, rules) === rawCode
      ? rawCode
      : tag !== undefined && isHeraErrorTag(tag)
        ? DEFAULT_ERROR_CODES[tag]
        : "unclassified_error"

  const isWhitelisted =
    tag !== undefined && isHeraErrorTag(tag) && whitelist.has(code)

  const rawMessage =
    Reflect.get(err, "message") ?? Reflect.get(err, "publicMessage")
  const keepsText = isWhitelisted || rules.errorMessages === "scrubbed"
  const message =
    keepsText && typeof rawMessage === "string"
      ? boundErrorMessage(rawMessage, rules)
      : REDACTED_VALUE

  const out: {
    _tag?: string
    name: string
    code: string
    message: string
    status?: number
    retryAfterSeconds?: number
    cause?: unknown
  } = {
    name,
    code,
    message,
  }

  if (tag !== undefined) {
    out._tag = scrubLogString(tag, rules)
  }

  const rawStatus =
    Reflect.get(err, "status") ?? Reflect.get(err, "httpStatus")
  if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
    out.status = rawStatus
  }

  const rawRetryAfter = Reflect.get(err, "retryAfterSeconds")
  if (typeof rawRetryAfter === "number" && Number.isFinite(rawRetryAfter)) {
    out.retryAfterSeconds = rawRetryAfter
  }

  const rawCause = Reflect.get(err, "cause")
  if (rawCause !== undefined && rawCause !== null) {
    out.cause =
      typeof rawCause === "object" && isErrorLike(rawCause)
        ? scrubInternal(rawCause, whitelist, depth + 1, seen, rules)
        : typeof rawCause === "string" && rules.errorMessages === "scrubbed"
          ? boundErrorMessage(rawCause, rules)
          : REDACTED_VALUE
  }

  return out
}

export function scrubInternal(
  value: unknown,
  whitelist: ReadonlySet<string>,
  depth: number,
  seen: WeakSet<object>,
  rules: ScrubRules = NO_RULES
): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (Redacted.isRedacted(value)) {
    return REDACTED_VALUE
  }
  if (typeof value === "string") {
    return scrubLogString(value, rules)
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "bigint") {
    return value.toString()
  }
  // Dropped, as `JSON.stringify` drops them: a function's source or a symbol's description is
  // text no value rule reads, so a credential in a closure would reach the line.
  if (typeof value === "symbol" || typeof value === "function") {
    return undefined
  }
  if (depth > MAX_SCRUB_DEPTH) {
    return TRUNCATED_VALUE
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return CIRCULAR_VALUE
    }
    seen.add(value)
    try {
      if (isErrorLike(value)) {
        return scrubErrorInstance(value, whitelist, depth, seen, rules)
      }
      if (value instanceof Date) {
        return Number.isNaN(value.getTime())
          ? "Invalid Date"
          : value.toISOString()
      }
      if (Array.isArray(value)) {
        return value.map((item) =>
          scrubInternal(item, whitelist, depth + 1, seen, rules)
        )
      }
      if (value instanceof Set) {
        return Array.from(value, (item) =>
          scrubInternal(item, whitelist, depth + 1, seen, rules)
        )
      }
      if (value instanceof Map) {
        const mapped: Record<string, unknown> = {}
        for (const [k, v] of value.entries()) {
          const keyStr = String(k)
          mapped[scrubLogString(keyStr, rules)] = isSecretKey(keyStr, rules)
            ? REDACTED_VALUE
            : scrubInternal(v, whitelist, depth + 1, seen, rules)
        }
        return mapped
      }

      const toJSON: unknown =
        "toJSON" in value ? Reflect.get(value, "toJSON") : undefined
      if (typeof toJSON === "function") {
        const serialized: unknown = Reflect.apply(toJSON, value, [])
        return scrubInternal(serialized, whitelist, depth + 1, seen, rules)
      }

      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        out[scrubLogString(k, rules)] = isSecretKey(k, rules)
          ? REDACTED_VALUE
          : scrubInternal(v, whitelist, depth + 1, seen, rules)
      }
      return out
    } finally {
      seen.delete(value)
    }
  }
  return String(value)
}

/**
 * Scrubs an arbitrary value for safe inclusion in structured logs.
 */
export function scrubLogValue(
  value: unknown,
  options?: ScrubOptions & RedactionRules
): unknown {
  const whitelist = normalizeWhitelist(options?.whitelistedErrorCodes)
  return scrubInternal(value, whitelist, 0, new WeakSet(), options)
}

/**
 * Scrubs a metadata record for safe inclusion in structured logs.
 */
export function scrubLogMetadata(
  metadata: Readonly<Record<string, unknown>>,
  options?: ScrubOptions & RedactionRules
): Record<string, unknown> {
  const whitelist = normalizeWhitelist(options?.whitelistedErrorCodes)
  const seen = new WeakSet<object>()
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    out[scrubLogString(key, options)] = isSecretKey(key, options)
      ? REDACTED_VALUE
      : scrubInternal(value, whitelist, 1, seen, options)
  }
  return out
}
