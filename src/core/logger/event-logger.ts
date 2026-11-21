import type * as Effect from "effect/Effect"
import { extractCorrelationOverrides, writeLogEntry, writeSyncEntry } from "./serializer.js"
import type { InternalLoggerState, LogLevel } from "./types.js"

/**
 * A call's fields. The tenant goes in as `orgId` (it fills the line's `org_id` slot unless the
 * logger already bound one); an `org_id` field is a reserved key dropped at runtime, so the type
 * refuses it.
 */
export type HeraLogFields = { readonly org_id?: never } & Readonly<
  Record<string, unknown>
>

/**
 * The `void` twin of {@link HeraEventLogger}, for code that logs outside an Effect (a queue
 * handler, a plain `catch`). Same line, same never-throw contract, wall clock instead of the fiber's.
 * Members are properties, not methods, so a `HeraEventLoggerSync<A>` is not assignable to a
 * `HeraEventLoggerSync<B>` that names an event `A` lacks.
 */
export interface HeraEventLoggerSync<E extends string> {
  readonly debug: (event: E, fields?: HeraLogFields) => void
  readonly info: (event: E, fields?: HeraLogFields) => void
  readonly warn: (event: E, fields?: HeraLogFields) => void
  readonly error: (event: E, fields?: HeraLogFields) => void
  readonly child: (
    fields: Readonly<Record<string, unknown>>
  ) => HeraEventLoggerSync<E>
}

/**
 * A logger whose events are `E`, its service's `as const` registry: an event outside it is a type
 * error at the call. Each line's `msg` and `event` are the event; fields bound at creation or by
 * `child` are pinned, written after the call's fields, so no call can spoof them.
 */
export interface HeraEventLogger<E extends string> {
  readonly debug: (event: E, fields?: HeraLogFields) => Effect.Effect<void>
  readonly info: (event: E, fields?: HeraLogFields) => Effect.Effect<void>
  readonly warn: (event: E, fields?: HeraLogFields) => Effect.Effect<void>
  readonly error: (event: E, fields?: HeraLogFields) => Effect.Effect<void>
  readonly child: (
    fields: Readonly<Record<string, unknown>>
  ) => HeraEventLogger<E>
  readonly sync: HeraEventLoggerSync<E>
}

/**
 * A registry as `createHeraLogger` takes it: the `as const` tuple of event names. A wide
 * `string[]` would admit every name, so it resolves to `never`.
 */
export type HeraLogEvents<E extends string> = ReadonlyArray<E> &
  (string extends E ? never : unknown)

/** `state` with `fields` bound: correlation keys replace their slots, the rest are pinned. */
function bindEventFields(
  state: InternalLoggerState,
  fields: Readonly<Record<string, unknown>>
): InternalLoggerState {
  const extracted = extractCorrelationOverrides(fields)
  return {
    ...state,
    requestId: extracted.requestId !== undefined ? extracted.requestId : state.requestId,
    orgId: extracted.orgId !== undefined ? extracted.orgId : state.orgId,
    actorId: extracted.actorId !== undefined ? extracted.actorId : state.actorId,
    span: extracted.span !== undefined ? extracted.span : state.span,
    pinnedFields: { ...state.pinnedFields, ...extracted.rest },
  }
}

function makeSync<E extends string>(
  state: InternalLoggerState
): HeraEventLoggerSync<E> {
  const write =
    (level: LogLevel) =>
    (event: E, fields?: HeraLogFields): void =>
      writeSyncEntry(state, level, event, fields, {
        pinned: { event },
        callCorrelation: true,
      })
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (fields) => makeSync(bindEventFields(state, fields)),
  }
}

export function makeEventLogger<E extends string>(
  state: InternalLoggerState
): HeraEventLogger<E> {
  const write =
    (level: LogLevel) =>
    (event: E, fields?: HeraLogFields): Effect.Effect<void> =>
      writeLogEntry(state, level, event, fields, {
        pinned: { event },
        callCorrelation: true,
      })
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (fields) => makeEventLogger(bindEventFields(state, fields)),
    sync: makeSync(state),
  }
}
