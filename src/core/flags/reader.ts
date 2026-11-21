/**
 * `HeraFlags.fromSource`: the reader every flag source shares. It owns the fallback,
 * the decode through the caller's schema and the warn line, so a test double built on it falls back
 * exactly as production does.
 *
 * Invariants:
 *  - `bool`, `value` and `evaluate` never fail: every failure answers the caller's fallback with one
 *    closed `reason`, and a value reaches the caller only after it decodes through the schema.
 *  - A fallback writes one warn line, `hera.flags.fallback` with `{ flag, reason }`, once per cause
 *    per snapshot. A source holds one snapshot object per context for its TTL, so a cause warns
 *    once a window, not once a request. No context value, token or body is logged.
 */

import { Option, Result } from "effect"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { fn } from "../fn/index.js"
import { HeraLoggerService } from "../logger/index.js"
import { decodeResult } from "../schema/index.js"
import type {
  HeraFlagContext,
  HeraFlagReader,
  HeraFlagReason,
  HeraFlagSnapshot,
  HeraFlagSource,
  HeraFlagValue,
} from "./types.js"

/** The stable message of the one warn line a fallback writes. */
export const HERA_FLAGS_FALLBACK = "hera.flags.fallback"

/** The cause key of a whole-read failure (it touches every flag at once). */
const WHOLE_READ = "*"

const warn = fn("HeraFlags.warn")(function* (flag: string, reason: HeraFlagReason) {
  const logger = yield* Effect.serviceOption(HeraLoggerService)
  if (Option.isSome(logger)) {
    yield* logger.value.warn(HERA_FLAGS_FALLBACK, { flag, reason })
  } else {
    yield* Effect.logWarning(HERA_FLAGS_FALLBACK).pipe(Effect.annotateLogs({ flag, reason }))
  }
})

export function fromSource(source: HeraFlagSource): HeraFlagReader {
  // Causes already warned, per snapshot object; a snapshot dropped by its source is collected.
  const warned = new WeakMap<HeraFlagSnapshot, Set<string>>()

  /** True the first time `cause` falls back on `snapshot`. */
  const firstTime = (snapshot: HeraFlagSnapshot, cause: string): boolean => {
    const seen = warned.get(snapshot) ?? new Set<string>()
    if (seen.has(cause)) return false
    seen.add(cause)
    warned.set(snapshot, seen)
    return true
  }

  const evaluate = fn("HeraFlags.evaluate")(function* <S extends Schema.Top>(
    name: string,
    schema: S,
    ctx: HeraFlagContext,
    fallback: S["Type"]
  ) {
    const snapshot = yield* source(ctx)
    const fallBack = function* (reason: HeraFlagReason, cause: string) {
      if (firstTime(snapshot, cause)) yield* warn(name, reason)
      return { value: fallback, source: "fallback", reason } as HeraFlagValue<S["Type"]>
    }
    if (!snapshot.ok) return yield* fallBack(snapshot.reason, WHOLE_READ)
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
