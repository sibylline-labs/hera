/**
 * `HeraFlags.fromSource`: the reader every flag source shares. It owns the fallback,
 * the decode through the caller's schema and the warn line, so a test double built on it falls back
 * exactly as production does.
 *
 * Invariants:
 *  - `bool`, `value` and `evaluate` never fail: every failure answers the caller's fallback with one
 *    closed `reason`, and a value reaches the caller only after it decodes through the schema.
 *  - A fallback writes one warn line, `hera.flags.fallback` with `{ flag, reason }`, once per
 *    context per cause per window, however many reads or snapshots hit it. A cause is a whole-read
 *    reason, or one flag's per-flag reason. The window runs from the line on the Effect `Clock`.
 *  - Warn history covers at most `maxContexts` contexts, the longest unwarned dropped first (it may
 *    warn again), and a context sheds its expired causes when it next warns. No context value,
 *    token or body is logged.
 */

import { Option, Result } from "effect"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { HERA_CACHE_DEFAULT_MAX_ENTRIES } from "../cache/index.js"
import { fn } from "../fn/index.js"
import { HeraLoggerService } from "../logger/index.js"
import { decodeResult } from "../schema/index.js"
import { contextKey } from "./ofrep-wire.js"
import type {
  HeraFlagContext,
  HeraFlagReader,
  HeraFlagReason,
  HeraFlagSource,
  HeraFlagSourceOptions,
  HeraFlagValue,
} from "./types.js"

/** The stable message of the one warn line a fallback writes. */
export const HERA_FLAGS_FALLBACK = "hera.flags.fallback"

/** How long a written line suppresses its repeats when the source names no window. */
const DEFAULT_WARN_WINDOW_MS = 60_000

const warn = fn("HeraFlags.warn")(function* (flag: string, reason: HeraFlagReason) {
  const logger = yield* Effect.serviceOption(HeraLoggerService)
  if (Option.isSome(logger)) {
    yield* logger.value.warn(HERA_FLAGS_FALLBACK, { flag, reason })
  } else {
    yield* Effect.logWarning(HERA_FLAGS_FALLBACK).pipe(Effect.annotateLogs({ flag, reason }))
  }
})

export function fromSource(source: HeraFlagSource, options: HeraFlagSourceOptions = {}): HeraFlagReader {
  const windowMs = options.warnWindowMs ?? DEFAULT_WARN_WINDOW_MS
  const maxContexts = options.maxContexts ?? HERA_CACHE_DEFAULT_MAX_ENTRIES
  // Context key to cause to the time its line was written. Insertion order is last-warned order.
  const warned = new Map<string, Map<string, number>>()

  /** True when `cause` has no line for `context` within the window, and records this one. It never
   *  yields, so of any number of concurrent fibers one gets true. */
  const claimLine = (context: string, cause: string, now: number): boolean => {
    const causes = warned.get(context) ?? new Map<string, number>()
    const at = causes.get(cause)
    if (at !== undefined && now - at < windowMs) return false
    for (const [held, heldAt] of causes) if (now - heldAt >= windowMs) causes.delete(held)
    causes.set(cause, now)
    warned.delete(context)
    warned.set(context, causes)
    for (const oldest of warned.keys()) {
      if (warned.size <= maxContexts) break
      warned.delete(oldest)
    }
    return true
  }

  const evaluate = fn("HeraFlags.evaluate")(function* <S extends Schema.Top>(
    name: string,
    schema: S,
    ctx: HeraFlagContext,
    fallback: S["Type"]
  ) {
    const snapshot = yield* source(ctx)
    // `flag` is given for a per-flag failure; a whole-read failure touches every flag at once. The
    // two reason sets are disjoint, so a cause string names one cause.
    const fallBack = function* (reason: HeraFlagReason, flag?: string) {
      const now = yield* Clock.currentTimeMillis
      const cause = flag === undefined ? reason : `${reason} ${flag}`
      if (claimLine(contextKey(ctx), cause, now)) yield* warn(name, reason)
      return { value: fallback, source: "fallback", reason } as HeraFlagValue<S["Type"]>
    }
    if (!snapshot.ok) return yield* fallBack(snapshot.reason)
    const evaluation = snapshot.flags.get(name)
    if (evaluation === undefined) return yield* fallBack("absent", name)
    if (!evaluation.ok) return yield* fallBack(evaluation.reason, name)
    const decoded = decodeResult(schema as S & { readonly DecodingServices: never }, evaluation.value)
    if (Result.isFailure(decoded)) return yield* fallBack("invalid", name)
    return { value: decoded.success, source: "flag", variant: evaluation.variant } as HeraFlagValue<S["Type"]>
  })

  const value = <S extends Schema.Top>(name: string, schema: S, ctx: HeraFlagContext, fallback: S["Type"]) =>
    Effect.map(evaluate(name, schema, ctx, fallback), (answer) => answer.value)

  return {
    evaluate,
    value,
    bool: (name, ctx, fallback) => value(name, Schema.Boolean, ctx, fallback),
  }
}
