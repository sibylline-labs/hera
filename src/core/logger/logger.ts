import * as Layer from "effect/Layer"
import {
  type HeraEventLogger,
  type HeraLogEvents,
  makeEventLogger,
} from "./event-logger.js"
import { normalizeWhitelist } from "./redaction.js"
import {
  defaultSink,
  extractCorrelationOverrides,
  writeLogEntry,
} from "./serializer.js"
import {
  type CreateHeraLoggerOptions,
  CurrentLogCorrelation,
  type HeraLogger,
  HeraLoggerService,
  type InternalLoggerState,
} from "./types.js"

export { CurrentLogCorrelation, HeraLoggerService }

/** The correlation slots this logger bound, so its layer hands them to every logger in the fiber. */
function boundSlots(state: InternalLoggerState): Record<string, string> {
  const slots: Record<string, string> = {}
  if (state.orgId !== null) slots.orgId = state.orgId
  if (state.requestId !== null) slots.requestId = state.requestId
  if (state.actorId !== null) slots.actorId = state.actorId
  return slots
}

export function makeLoggerFromState(state: InternalLoggerState): HeraLogger {
  const child = (fields: Readonly<Record<string, unknown>>): HeraLogger => {
    const extracted = extractCorrelationOverrides(fields)
    const nextState: InternalLoggerState = {
      service: state.service,
      requestId:
        extracted.requestId !== undefined
          ? extracted.requestId
          : state.requestId,
      orgId: extracted.orgId !== undefined ? extracted.orgId : state.orgId,
      actorId:
        extracted.actorId !== undefined ? extracted.actorId : state.actorId,
      span: extracted.span !== undefined ? extracted.span : state.span,
      boundFields: {
        ...state.boundFields,
        ...extracted.rest,
      },
      whitelist: state.whitelist,
      sink: state.sink,
      teeSinkWhenCaptured: state.teeSinkWhenCaptured,
      rules: state.rules,
      pinnedFields: state.pinnedFields,
    }
    return makeLoggerFromState(nextState)
  }

  const self: HeraLogger = {
    debug: (msg, metadata) => writeLogEntry(state, "debug", msg, metadata),
    info: (msg, metadata) => writeLogEntry(state, "info", msg, metadata),
    warn: (msg, metadata) => writeLogEntry(state, "warn", msg, metadata),
    error: (msg, metadata) => writeLogEntry(state, "error", msg, metadata),
    child,
    get layer(): Layer.Layer<HeraLoggerService> {
      return Layer.mergeAll(
        Layer.succeed(HeraLoggerService, self),
        Layer.succeed(CurrentLogCorrelation, {
          ...state.boundFields,
          ...boundSlots(state),
        })
      )
    },
  }

  return self
}

/**
 * Creates a structured single-line JSON `HeraEventLogger<E>` that logs only the events in
 * `options.events`, the service's `as const` registry (read for its type only). `options.fields`
 * are pinned on every line.
 */
export function createHeraLogger<const E extends string>(
  options: CreateHeraLoggerOptions & { readonly events: HeraLogEvents<E> }
): HeraEventLogger<E>
/**
 * Creates a structured single-line JSON `HeraLogger` with automatic `Redacted<T>`,
 * credential-key/value, and `Error` scrubbing.
 */
export function createHeraLogger(options: CreateHeraLoggerOptions): HeraLogger
export function createHeraLogger(
  options: CreateHeraLoggerOptions & { readonly events?: ReadonlyArray<string> }
): HeraLogger | HeraEventLogger<string> {
  const extracted = options.fields
    ? extractCorrelationOverrides(options.fields)
    : { rest: {} }

  const state: InternalLoggerState = {
    service: options.service,
    requestId:
      options.requestId !== undefined
        ? options.requestId
        : (extracted.requestId ?? null),
    orgId:
      options.orgId !== undefined
        ? options.orgId
        : (extracted.orgId ?? null),
    actorId:
      options.actorId !== undefined
        ? options.actorId
        : (extracted.actorId ?? null),
    span:
      options.span !== undefined ? options.span : (extracted.span ?? null),
    boundFields: options.events === undefined ? extracted.rest : {},
    whitelist: normalizeWhitelist(options.whitelistedErrorCodes),
    sink: options.sink ?? defaultSink,
    teeSinkWhenCaptured: options.teeSinkWhenCaptured === true,
    rules: {
      secretKeys: options.secretKeys,
      secretShapes: options.secretShapes,
      errorMessages: options.errorMessages,
    },
    pinnedFields: options.events === undefined ? {} : extracted.rest,
  }

  return options.events === undefined
    ? makeLoggerFromState(state)
    : makeEventLogger(state)
}
