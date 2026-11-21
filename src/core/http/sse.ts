import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { sseCommentFrame, sseDataFrame, sseErrorFrame, sseSentinelFrame } from "./sse-frames.js"

/** What a writer reads events from: values it frames as JSON, in order. */
export type HeraSseSourceValue<A> = AsyncIterable<A> | Stream.Stream<A, unknown>

/**
 * A source, or a factory handed the signal the writer aborts when the stream ends early
 * (cancelled or failed), so the caller can stop upstream work.
 */
export type HeraSseSource<A> = HeraSseSourceValue<A> | ((signal: AbortSignal) => HeraSseSourceValue<A>)

/** How a stream ended: the source completed, the client went away, or it failed with a code. */
export type HeraSseOutcome<C extends string> =
  | { readonly _tag: "done" }
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "failed"; readonly code: C }

/**
 * The only text an error frame can carry: a static public message per code. `classify` picks the
 * code for a failure; the failure itself never reaches the wire.
 */
export interface HeraSseErrors<C extends string> {
  readonly messages: Readonly<Record<C, string>>
  readonly classify: (cause: unknown) => C
}

export interface HeraSseKeepalive {
  /** A comment is written when no frame went out since the previous tick of this interval. */
  readonly interval: Duration.Input
  /** The comment text; defaults to `keepalive`. */
  readonly comment?: string | undefined
}

export interface HeraSseOptions<C extends string> {
  readonly keepalive?: HeraSseKeepalive | undefined
  /** Written as `data: <sentinel>` after the last frame, only when the source completes. */
  readonly sentinel?: string | undefined
  /** Defaults to one code, `stream_failed`, with the message `Stream failed`. */
  readonly errors?: HeraSseErrors<C> | undefined
  /** Aborting it fails the stream with its reason (a deadline, a lost lease): an error frame. */
  readonly signal?: AbortSignal | undefined
  /**
   * The route's `request.signal`. Aborting it ends the stream as cancelled. On Workers a client
   * disconnect does not cancel the response body; it aborts `request.signal`, and only with the
   * `enable_request_signal` compatibility flag.
   */
  readonly disconnect?: AbortSignal | undefined
  /** Runs once when the stream ends; a throw from it is ignored. */
  readonly onEnd?: ((outcome: HeraSseOutcome<C>) => void) | undefined
}

const DEFAULT_ERRORS: HeraSseErrors<"stream_failed"> = {
  messages: { stream_failed: "Stream failed" },
  classify: () => "stream_failed",
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
} as const

function toStream<A>(source: HeraSseSource<A>, signal: AbortSignal): Stream.Stream<A, unknown> {
  const value = typeof source === "function" ? source(signal) : source
  return Stream.isStream(value)
    ? (value as Stream.Stream<A, unknown>)
    : Stream.fromAsyncIterable(value, (error) => error)
}

/** Never succeeds; fails with the signal's reason once it aborts. */
function abortedWith(signal: AbortSignal): Effect.Effect<never, unknown> {
  return Effect.callback<never, unknown>((resume) => {
    const onAbort = () => resume(Effect.fail(signal.reason))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
}

/**
 * The code and message an error frame carries, always a row of `errors.messages`: a `classify` that
 * throws or returns a code outside the table falls back to the table's first row, and an empty
 * table to the default `stream_failed` row.
 */
function errorRow<C extends string>(errors: HeraSseErrors<C>, cause: unknown): { code: C; message: string } {
  const table: Readonly<Record<string, string>> = errors.messages
  let code: string | undefined
  try {
    code = errors.classify(cause)
  } catch {
    code = undefined
  }
  if (code === undefined || !Object.hasOwn(table, code)) {
    code = Object.keys(table)[0]
  }
  if (code === undefined) {
    return { code: "stream_failed" as C, message: DEFAULT_ERRORS.messages.stream_failed }
  }
  return { code: code as C, message: table[code]! }
}

/**
 * Answers a route with a `200 text/event-stream` body: `data: <json>` per source value, `: <comment>`
 * keepalives while the source is idle, `data: <sentinel>` when it completes, and, when it fails
 * after headers flushed, one `data: {"error":{"code","message"}}` frame instead of the sentinel.
 * A failure before the handler returns stays the route's problem+json. Cancelling the body or
 * aborting `disconnect` ends the stream and aborts the signal the source factory received. Timing
 * follows the fiber's `Clock`, so `TestClock` drives keepalives in tests.
 */
export function sse<A, C extends string = "stream_failed">(
  source: HeraSseSource<A>,
  options?: HeraSseOptions<C>
): Effect.Effect<Response> {
  return Effect.suspend(() => {
    const errors = (options?.errors ?? DEFAULT_ERRORS) as HeraSseErrors<C>
    const sentinel = options?.sentinel === undefined ? undefined : sseSentinelFrame(options.sentinel)
    const comment =
      options?.keepalive === undefined ? undefined : sseCommentFrame(options.keepalive.comment ?? "keepalive")
    const upstream = new AbortController()
    let outcome: HeraSseOutcome<C> | undefined
    let wrote = false

    let frames = Stream.suspend(() => toStream(source, upstream.signal))
    if (options?.signal !== undefined) {
      frames = Stream.merge(frames, Stream.fromEffectDrain(abortedWith(options.signal)), { haltStrategy: "left" })
    }
    let body: Stream.Stream<string, unknown> = frames.pipe(
      // One frame per chunk: a value that fails to frame never takes the frames before it down.
      Stream.rechunk(1),
      Stream.map(sseDataFrame),
      Stream.tap(() => Effect.sync(() => (wrote = true))),
      Stream.concat(
        Stream.suspend(() => {
          outcome ??= { _tag: "done" }
          return sentinel === undefined ? Stream.empty : Stream.make(sentinel)
        })
      )
    )
    if (options?.keepalive !== undefined && comment !== undefined) {
      const keepalives = Stream.tick(options.keepalive.interval).pipe(
        Stream.drop(1),
        Stream.filter(() => {
          const idle = !wrote
          wrote = false
          return idle
        }),
        Stream.map(() => comment)
      )
      body = Stream.merge(body, keepalives, { haltStrategy: "left" })
    }
    body = body.pipe(
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Stream.failCause(cause)
        }
        const { code, message } = errorRow(errors, Cause.squash(cause))
        outcome ??= { _tag: "failed", code }
        return Stream.make(sseErrorFrame(code, message))
      })
    )
    const disconnect = options?.disconnect
    if (disconnect !== undefined) {
      body = disconnect.aborted
        ? Stream.empty
        : body.pipe(Stream.interruptWhen(abortedWith(disconnect).pipe(Effect.ignore)))
    }
    const encoded = body.pipe(
      Stream.ensuring(
        Effect.sync(() => {
          const ended = outcome ?? { _tag: "cancelled" }
          if (ended._tag !== "done") {
            upstream.abort(new DOMException("The event stream ended.", "AbortError"))
          }
          try {
            options?.onEnd?.(ended)
          } catch {
            // A throwing callback must not error a stream that already ended.
          }
        })
      ),
      Stream.encodeText
    )
    return Stream.toReadableStreamEffect(encoded).pipe(
      Effect.map((readable) => new Response(readable, { status: 200, headers: SSE_HEADERS }))
    )
  })
}
