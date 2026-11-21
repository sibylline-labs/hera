import type { TelemetryLogCapture } from "../telemetry/capture.js"
import type { AmbientCorrelation } from "./ambient.js"
import { isSecretKey, scrubInternal, scrubLogString } from "./redaction.js"
import {
  type InternalLoggerState,
  type LogEntry,
  type LogLevel,
  REDACTED_VALUE,
  RESERVED_LOG_KEYS,
} from "./types.js"

/** What a line reads from where it was written: the clock, the active span, ambient fields. */
export interface LogAmbient {
  readonly nowMs: number
  readonly span: string | null
  readonly fields: Readonly<Record<string, unknown>>
  /** Correlation the fiber carries; fills only the slots the logger and the call left `null`. */
  readonly correlation?: AmbientCorrelation | undefined
  /** The exporting telemetry invocation the line was written in; it receives the scrubbed entry. */
  readonly capture?: TelemetryLogCapture | undefined
  /** Skip the sink when a capture took the line: unset only for a logger made to tee. */
  readonly suppressSink?: boolean | undefined
}

export interface EmitOptions {
  /** Written after every other field (an event logger's `event`). Built by Hera, never a caller. */
  readonly pinned?: Readonly<Record<string, unknown>> | undefined
  /** Read `orgId` / `requestId` / `actorId` from the call's fields into an unbound slot. */
  readonly callCorrelation?: boolean | undefined
}

interface Correlation {
  orgId: string | null
  requestId: string | null
  actorId: string | null
}

const CALL_CORRELATION_KEYS = ["orgId", "requestId", "actorId"] as const

/**
 * The call's fields minus its camelCase correlation keys, which fill a slot only where the logger
 * bound none: a bound (`child`) value wins, so a call cannot re-key a line. Snake-case slots
 * (`org_id`) stay reserved keys and are dropped.
 */
function takeCallCorrelation(
  fields: Readonly<Record<string, unknown>>,
  slots: Correlation
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...fields }
  for (const key of CALL_CORRELATION_KEYS) {
    const value = rest[key]
    delete rest[key]
    if (typeof value === "string" && slots[key] === null) {
      slots[key] = value
    }
  }
  return rest
}

const W3C_TRACE_ID = /^[0-9a-f]{32}$/
const W3C_SPAN_ID = /^[0-9a-f]{16}$/

/**
 * Fills each `null` slot from the fiber's correlation, and answers the reserved ids only the fiber
 * can supply (`actor_kind`, `trace_id`, `span_id`), each present only when known. Ambient values
 * can come from a propagated span or a caller-provided reference, so each one is scrubbed, and an
 * id that is not W3C-shaped is dropped.
 */
function fillFromAmbient(
  state: InternalLoggerState,
  slots: Correlation,
  correlation: AmbientCorrelation | undefined
): { actor_kind?: string; trace_id?: string; span_id?: string } {
  if (correlation === undefined) {
    return {}
  }
  const scrub = (value: string | null): string | null =>
    value === null ? null : scrubLogString(value, state.rules)
  for (const key of CALL_CORRELATION_KEYS) {
    slots[key] ??= scrub(correlation[key])
  }
  const { actorKind, traceId, spanId } = correlation
  return {
    ...(actorKind !== null ? { actor_kind: scrubLogString(actorKind, state.rules) } : {}),
    ...(traceId !== null && W3C_TRACE_ID.test(traceId) ? { trace_id: traceId } : {}),
    ...(spanId !== null && W3C_SPAN_ID.test(spanId) ? { span_id: spanId } : {}),
  }
}

/**
 * `options.pinned` with every value scrubbed or dropped, for the paths that cannot run the full
 * scrub. The event is typed, but a cast can carry any string at runtime.
 */
function safePinned(
  state: InternalLoggerState,
  options: EmitOptions
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(options.pinned ?? {})) {
    if (typeof v === "string") {
      out[k] = scrubLogString(v, state.rules)
    }
  }
  return out
}

function scrubFields(
  state: InternalLoggerState,
  fields: Readonly<Record<string, unknown>>,
  out: Record<string, unknown>
): void {
  const seen = new WeakSet<object>()
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED_LOG_KEYS.has(k)) {
      continue
    }
    out[scrubLogString(k, state.rules)] = isSecretKey(k, state.rules)
      ? REDACTED_VALUE
      : scrubInternal(v, state.whitelist, 1, seen, state.rules)
  }
}

/** Hands the entry to the invocation's capture, then to the sink unless the capture replaces it. */
function deliver(
  state: InternalLoggerState,
  level: LogLevel,
  line: string,
  entry: LogEntry,
  ambient: LogAmbient
): void {
  if (ambient.capture !== undefined) {
    ambient.capture.log(level, entry, ambient.nowMs)
    if (ambient.suppressSink === true) {
      return
    }
  }
  state.sink(line, entry)
}

function writeEntry(
  state: InternalLoggerState,
  level: LogLevel,
  msg: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
  ambient: LogAmbient,
  options: EmitOptions
): void {
  const timestamp = new Date(ambient.nowMs).toISOString()
  const slots: Correlation = {
    orgId: state.orgId,
    requestId: state.requestId,
    actorId: state.actorId,
  }

  // Pinned fields are scrubbed on their own, so a call whose fields cannot be read still writes them.
  let pinned: Record<string, unknown> = {}
  try {
    scrubFields(state, { ...state.pinnedFields, ...options.pinned }, pinned)
  } catch {
    pinned = safePinned(state, options)
  }

  let fields: Record<string, unknown> = {}
  try {
    // Reading the call's fields runs its getters and Proxy traps, so it sits inside the guard.
    const call =
      options.callCorrelation === true && metadata !== undefined
        ? takeCallCorrelation(metadata, slots)
        : (metadata ?? {})
    scrubFields(state, { ...ambient.fields, ...state.boundFields, ...call }, fields)
  } catch {
    fields = { log_error: "unserializable_metadata" }
  }

  const ambientIds = fillFromAmbient(state, slots, ambient.correlation)
  const safeMsg = scrubLogString(msg, state.rules)
  const head = {
    timestamp,
    level,
    service: state.service,
    msg: safeMsg,
    request_id: slots.requestId,
    org_id: slots.orgId,
    actor_id: slots.actorId,
    span: ambient.span,
    ...ambientIds,
  }
  const entry: LogEntry = { ...fields, ...pinned, ...head }

  let line: string
  try {
    line = JSON.stringify(entry)
  } catch {
    const fallback: LogEntry = {
      ...pinned,
      ...head,
      log_error: "unserializable_entry",
    }
    line = JSON.stringify(fallback)
    deliver(state, level, line, fallback, ambient)
    return
  }
  deliver(state, level, line, entry, ambient)
}

const CONSOLE_METHOD = {
  debug: "log",
  info: "log",
  warn: "warn",
  error: "error",
} as const

/**
 * The last resort: a line that names what was logged and nothing a caller supplied beyond the
 * event, still keyed by the bound org. Tries the sink, then `console`, then gives up.
 */
function writeMinimal(
  state: InternalLoggerState,
  level: LogLevel,
  msg: string,
  options: EmitOptions
): void {
  try {
    const entry: LogEntry = {
      ...safePinned(state, options),
      timestamp: new Date().toISOString(),
      level,
      service: state.service,
      msg: scrubLogString(msg, state.rules),
      request_id: state.requestId,
      org_id: state.orgId,
      actor_id: state.actorId,
      span: state.span,
      log_error: "log_write_failed",
    }
    const line = JSON.stringify(entry)
    try {
      state.sink(line, entry)
    } catch {
      console[CONSOLE_METHOD[level]](line)
    }
  } catch {
    // Nothing left to write with; a log call still never throws.
  }
}

/**
 * Writes one line through the logger's sink and never throws: a log call runs inside catch blocks
 * and queue handlers, where a throw would lose the failure it was reporting. A field that cannot be
 * read degrades to `log_error`; a sink or clock that throws degrades to the minimal line.
 */
export function emitLogEntry(
  state: InternalLoggerState,
  level: LogLevel,
  msg: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
  ambient: LogAmbient,
  options: EmitOptions = {}
): void {
  try {
    writeEntry(state, level, msg, metadata, ambient, options)
  } catch {
    writeMinimal(state, level, msg, options)
  }
}

/** The ambient a line written outside any fiber has: the wall clock and the logger's own span. */
export function wallClockAmbient(state: InternalLoggerState): LogAmbient {
  return { nowMs: Date.now(), span: state.span, fields: {} }
}

/** {@link emitLogEntry} on the wall clock; a clock that throws is a write failure, not a throw. */
export function emitWallClock(
  state: InternalLoggerState,
  level: LogLevel,
  msg: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
  options: EmitOptions = {}
): void {
  let ambient: LogAmbient
  try {
    ambient = wallClockAmbient(state)
  } catch {
    writeMinimal(state, level, msg, options)
    return
  }
  emitLogEntry(state, level, msg, metadata, ambient, options)
}
