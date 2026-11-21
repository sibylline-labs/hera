/**
 * Server-Sent Events frames as the exact text a `text/event-stream` body carries. Each frame ends
 * with a blank line. A raw CR or LF inside a field would end it early and let the rest read as a
 * new field or event, so the text frames refuse one.
 */

const LINE_BREAK = /[\r\n]/

/** Throws a `TypeError` when `text` holds a CR or LF, which would split an SSE frame. */
export function assertSseLine(text: string, what: string): void {
  if (LINE_BREAK.test(text)) {
    throw new TypeError(`HeraHttp.sse: ${what} must not contain a line break`)
  }
}

/**
 * `data: <JSON>` for one event. `JSON.stringify` escapes every line break, so the frame is one line;
 * a value with no JSON form (`undefined`, a function) throws a `TypeError`, as `HeraHttp.raw` does.
 */
export function sseDataFrame(value: unknown): string {
  const json = JSON.stringify(value) as string | undefined
  if (json === undefined) {
    throw new TypeError("HeraHttp.sse: value has no JSON representation")
  }
  return `data: ${json}\n\n`
}

/** `data: <text>` written verbatim, for a terminal sentinel such as `[DONE]`. */
export function sseSentinelFrame(text: string): string {
  assertSseLine(text, "sentinel")
  return `data: ${text}\n\n`
}

/** `: <text>`, a comment line every SSE client ignores; a keepalive. */
export function sseCommentFrame(text: string): string {
  assertSseLine(text, "comment")
  return `: ${text}\n\n`
}

/** `data: {"error":{"code","message"}}`, the in-stream failure once headers have flushed. */
export function sseErrorFrame(code: string, message: string): string {
  return sseDataFrame({ error: { code, message } })
}
