import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as Tracer from "effect/Tracer"
import * as Fiber from "effect/Fiber"
import { CurrentTelemetryCapture } from "../telemetry/capture.js"
import { readAmbientCorrelation } from "./ambient.js"
import {
  type EmitOptions,
  emitLogEntry,
  emitWallClock,
  type LogAmbient,
  wallClockAmbient,
} from "./emit.js"
import {
  CurrentLogCorrelation,
  type InternalLoggerState,
  type LogEntry,
  type LogLevel,
  RESERVED_LOG_KEYS,
} from "./types.js"

export function defaultSink(line: string, entry: LogEntry): void {
  switch (entry.level) {
    case "error":
      console.error(line)
      break
    case "warn":
      console.warn(line)
      break
    case "debug":
    case "info":
      console.log(line)
      break
  }
}

export function extractCorrelationOverrides(
  fields: Readonly<Record<string, unknown>>
): {
  readonly requestId?: string | null
  readonly orgId?: string | null
  readonly actorId?: string | null
  readonly span?: string | null
  readonly rest: Record<string, unknown>
} {
  let requestId: string | null | undefined
  let orgId: string | null | undefined
  let actorId: string | null | undefined
  let span: string | null | undefined
  const rest: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(fields)) {
    if (
      (key === "request_id" || key === "requestId") &&
      (typeof value === "string" || value === null)
    ) {
      requestId = value
    } else if (
      (key === "org_id" || key === "orgId") &&
      (typeof value === "string" || value === null)
    ) {
      orgId = value
    } else if (
      (key === "actor_id" || key === "actorId") &&
      (typeof value === "string" || value === null)
    ) {
      actorId = value
    } else if (key === "span" && (typeof value === "string" || value === null)) {
      span = value
    } else if (!RESERVED_LOG_KEYS.has(key)) {
      rest[key] = value
    }
  }

  return {
    ...(requestId !== undefined ? { requestId } : {}),
    ...(orgId !== undefined ? { orgId } : {}),
    ...(actorId !== undefined ? { actorId } : {}),
    ...(span !== undefined ? { span } : {}),
    rest,
  }
}

export function readFiberAmbient(
  fiber: Fiber.Fiber<unknown, unknown>,
  state: InternalLoggerState
): LogAmbient {
  const nowMs = fiber.getRef(Clock.Clock).currentTimeMillisUnsafe()
  const currentSpanOpt = Context.getOption(fiber.context, Tracer.ParentSpan)
  const logSpans = fiber.getRef(References.CurrentLogSpans)
  const span =
    state.span ??
    (Option.isSome(currentSpanOpt)
      ? currentSpanOpt.value._tag === "Span"
        ? currentSpanOpt.value.name
        : currentSpanOpt.value.spanId
      : logSpans.length > 0 && logSpans[0] !== undefined
        ? logSpans[0][0]
        : null)
  const { rest, span: _boundSpan, ...bound } = extractCorrelationOverrides(
    fiber.getRef(CurrentLogCorrelation)
  )
  return {
    nowMs,
    span,
    fields: { ...fiber.getRef(References.CurrentLogAnnotations), ...rest },
    correlation: readAmbientCorrelation(fiber.context, bound),
    capture: fiber.getRef(CurrentTelemetryCapture),
    suppressSink: !state.teeSinkWhenCaptured,
  }
}

/**
 * The Effect a log call returns: reads the fiber's clock, span and annotations, then writes through
 * {@link emitLogEntry}. It never fails and never dies.
 */
export function writeLogEntry(
  state: InternalLoggerState,
  level: LogLevel,
  msg: string,
  metadata?: Readonly<Record<string, unknown>>,
  options?: EmitOptions
): Effect.Effect<void> {
  return Effect.withFiber((fiber) =>
    Effect.sync(() => {
      let ambient: LogAmbient
      try {
        ambient = readFiberAmbient(fiber, state)
      } catch {
        ambient = wallClockAmbient(state)
      }
      emitLogEntry(state, level, msg, metadata, ambient, options)
    })
  )
}

/**
 * The write behind a `.sync` call. Inside a running fiber (a hera callback such as `rpcClient`'s `onTransportError`) the
 * line reads that fiber's ambient as {@link writeLogEntry} does; outside one it is the wall clock.
 * Effect sets the current fiber only while its run loop executes, so a resumed async continuation
 * never sees a stale one.
 */
export function writeSyncEntry(
  state: InternalLoggerState,
  level: LogLevel,
  msg: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
  options: EmitOptions = {}
): void {
  let ambient: LogAmbient | undefined
  try {
    const fiber = Fiber.getCurrent()
    if (fiber !== undefined) ambient = readFiberAmbient(fiber, state)
  } catch {
    ambient = undefined
  }
  if (ambient === undefined) {
    emitWallClock(state, level, msg, metadata, options)
    return
  }
  emitLogEntry(state, level, msg, metadata, ambient, options)
}
