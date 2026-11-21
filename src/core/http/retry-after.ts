/**
 * Parsed result from an HTTP `Retry-After` header.
 */
export interface RetryAfterParsed {
  readonly retryAfterSeconds: number | null
  readonly retryAfterMs: number | null
}

const DELTA_SECONDS_RE = /^\d+$/

const WKDAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)"
const WEEKDAY =
  "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"

// IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
const IMF_FIXDATE_RE = new RegExp(
  `^${WKDAY}, \\d{2} ${MONTH} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT$`
)
// obsolete RFC 850: Sunday, 06-Nov-94 08:49:37 GMT
const RFC850_DATE_RE = new RegExp(
  `^${WEEKDAY}, \\d{2}-${MONTH}-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT$`
)
// ANSI C asctime(): Sun Nov  6 08:49:37 1994
const ASCTIME_DATE_RE = new RegExp(
  `^${WKDAY} ${MONTH} (?: \\d|\\d{2}) \\d{2}:\\d{2}:\\d{2} \\d{4}$`
)

function parseHttpDateMs(trimmed: string): number | null {
  if (
    IMF_FIXDATE_RE.test(trimmed) ||
    RFC850_DATE_RE.test(trimmed) ||
    ASCTIME_DATE_RE.test(trimmed)
  ) {
    const normalized = ASCTIME_DATE_RE.test(trimmed)
      ? `${trimmed} GMT`
      : trimmed
    const ms = Date.parse(normalized)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/**
 * Parses an HTTP `Retry-After` header value per RFC 9110 §10.2.3 (`delta-seconds` or `HTTP-date`).
 */
export function parseRetryAfter(
  raw: string | null | undefined,
  nowMs: number = Date.now()
): RetryAfterParsed {
  if (typeof raw !== "string") {
    return { retryAfterSeconds: null, retryAfterMs: null }
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { retryAfterSeconds: null, retryAfterMs: null }
  }
  if (DELTA_SECONDS_RE.test(trimmed)) {
    const seconds = Number(trimmed)
    if (
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      !Number.isSafeInteger(seconds) ||
      !Number.isSafeInteger(seconds * 1000)
    ) {
      return { retryAfterSeconds: null, retryAfterMs: null }
    }
    return {
      retryAfterSeconds: seconds,
      retryAfterMs: seconds * 1000,
    }
  }
  const dateMs = parseHttpDateMs(trimmed)
  if (dateMs !== null) {
    const deltaMs = Math.max(0, dateMs - nowMs)
    const deltaSec = Math.max(0, Math.ceil((dateMs - nowMs) / 1000))
    if (!Number.isSafeInteger(deltaSec) || !Number.isSafeInteger(deltaMs)) {
      return { retryAfterSeconds: null, retryAfterMs: null }
    }
    return {
      retryAfterSeconds: deltaSec,
      retryAfterMs: deltaMs,
    }
  }
  return { retryAfterSeconds: null, retryAfterMs: null }
}

export function extractBodyRetryAfter(
  text: string,
  nowMs: number
): RetryAfterParsed {
  if (!text || text.length === 0) {
    return { retryAfterSeconds: null, retryAfterMs: null }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === "object" && parsed !== null) {
      const candidate =
        Reflect.get(parsed, "retry_after") ?? Reflect.get(parsed, "retryAfter")
      if (
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate >= 0
      ) {
        const sec = Math.ceil(candidate)
        return { retryAfterSeconds: sec, retryAfterMs: sec * 1000 }
      }
      if (typeof candidate === "string") {
        return parseRetryAfter(candidate, nowMs)
      }
    }
  } catch {
    // Non-JSON 429 body
  }
  return { retryAfterSeconds: null, retryAfterMs: null }
}
