import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import type * as LogLevel from "effect/LogLevel"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import { scrubLogValue } from "../logger/redaction.js"
import { type TelemetryLogCapture, CurrentTelemetryCapture } from "./capture.js"
import type { ResolvedTelemetryConfig } from "./config.js"
import { describeFailure } from "./exception.js"
import { postOtlp } from "./export.js"
import { exportedParentIds, withExportedSpan } from "./exported-parents.js"
import { buildLogsRequest } from "./otlp-logs.js"
import { buildTraceRequest } from "./otlp-traces.js"
import { toAttributes } from "./otlp-values.js"
import { makeRing } from "./ring.js"
import { resolveTraceContext } from "./sampling.js"
import type {
  CapturedLogRecord,
  CapturedSpan,
  HeraTelemetryBeginOptions,
  HeraTelemetryEnd,
  HeraTelemetryInvocation,
  HeraTelemetryLevel,
} from "./types.js"

/** Fields a Hera log line carries that the OTLP record holds elsewhere (body, time, severity, ids). */
const LINE_FIELDS = new Set(["msg", "level", "timestamp", "trace_id", "span_id"])

const EFFECT_LEVEL: Readonly<Record<LogLevel.LogLevel, HeraTelemetryLevel | undefined>> = {
  All: "debug",
  Trace: "debug",
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
  Fatal: "error",
  None: undefined,
}

/** The invocation that exports nothing: unconfigured telemetry keeps the logger's console sink. */
export const NOOP_INVOCATION: HeraTelemetryInvocation = {
  sampled: false,
  provide: (effect) => effect,
  end: () => undefined,
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * One invocation's tracer, loggers and buffers. Finished spans and `info` records
 * go to rings; `warn` and `error` records are kept for individual export; an `error` record, a
 * failed span, a 5xx, a defect or a slow run promotes the rings. Nothing is serialized until
 * `end()` hands the export to `waitUntil`.
 */
export function beginInvocation(
  config: ResolvedTelemetryConfig,
  options: HeraTelemetryBeginOptions
): HeraTelemetryInvocation {
  const trace = resolveTraceContext({
    source: options.source,
    traceparent: options.traceparent,
    headRate: config.headRate,
    random: config.random,
  })
  const startMs = config.now()
  const spans = makeRing<CapturedSpan>(config.maxBufferedSpans)
  const infos = makeRing<CapturedLogRecord>(config.maxBufferedLogs)
  const loud: Array<CapturedLogRecord> = []
  let loudDropped = 0
  let promoted = false
  let ended = false

  const record = (entry: CapturedLogRecord): void => {
    if (entry.level === "debug") return
    if (entry.level === "info") return infos.push(entry)
    if (entry.level === "error") promoted = true
    if (loud.length < config.maxBufferedLogs) loud.push(entry)
    else loudDropped += 1
  }

  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan({ ...spanOptions, sampled: trace.sampled })
      const finish = span.end.bind(span)
      span.end = (endTime, exit) => {
        finish(endTime, exit)
        const failure = Exit.isFailure(exit) ? describeFailure(exit.cause, { ...config.rules, errorMessages: config.errorMessages }) : undefined
        if (failure?.errored === true) promoted = true
        spans.push({
          span,
          endNs: endTime,
          errored: failure?.errored ?? false,
          ...(failure?.exception !== undefined ? { exception: failure.exception } : {}),
          ...(failure?.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
        })
      }
      return span
    },
  })

  const capture: TelemetryLogCapture = {
    log(level, entry, timeMs) {
      const attributes: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(entry)) {
        if (!LINE_FIELDS.has(key) && value !== null && value !== undefined) attributes[key] = value
      }
      record({
        timeMs,
        level,
        body: stringOr(entry.msg) ?? "",
        attributes,
        traceId: stringOr(entry.trace_id),
        spanId: stringOr(entry.span_id),
      })
    },
  }

  const effectLogger = Logger.make((log) => {
    const level = EFFECT_LEVEL[log.logLevel]
    if (level === undefined) return
    const message: unknown = Array.isArray(log.message) && log.message.length === 1 ? log.message[0] : log.message
    const body = scrubLogValue(message, config.rules)
    const span = Context.getOption(log.fiber.context, Tracer.ParentSpan)
    record({
      timeMs: log.date.getTime(),
      level,
      body: typeof body === "string" ? body : JSON.stringify(body) ?? "",
      attributes: {},
      ...(Option.isSome(span) ? { traceId: span.value.traceId, spanId: span.value.spanId } : {}),
    })
  })

  const references = Layer.mergeAll(
    Layer.succeed(Tracer.Tracer, tracer),
    Layer.succeed(Logger.CurrentLoggers, new Set<Logger.Logger<unknown, unknown>>([effectLogger])),
    Layer.succeed(CurrentTelemetryCapture, capture)
  )
  const layer = trace.parent === undefined ? references : Layer.merge(references, Layer.succeed(Tracer.ParentSpan, trace.parent))
  // A fresh root drops any span the calling fiber carries (an outer invocation's), so its spans start
  // their own trace instead of parenting under a span this invocation never exports.
  const isolate = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    trace.parent === undefined
      ? // The cast keeps `R`: an effect that requires ParentSpan from outside a fresh root is the inheritance removed here.
        Effect.updateContext(effect, (context: Context.Context<R>) => Context.omit(Tracer.ParentSpan)(context) as Context.Context<R>)
      : effect

  const flush = async (exportAll: boolean): Promise<void> => {
    const resource = toAttributes(config.resource, config.rules)
    const finished = exportAll ? spans.items() : []
    const parents = exportedParentIds(finished, trace.parent)
    const logs = (exportAll ? [...infos.items(), ...loud].sort((a, b) => a.timeMs - b.timeMs) : loud).map((record) =>
      withExportedSpan(record, parents)
    )
    const dropped = { traces: exportAll ? spans.dropped() : 0, logs: loudDropped + (exportAll ? infos.dropped() : 0) }
    const posts: Array<Promise<void>> = []
    const send = (signal: "traces" | "logs", records: number, payload: () => unknown): void => {
      posts.push(
        postOtlp(config, signal, JSON.stringify(payload())).then((outcome) =>
          config.onExport({ signal, outcome, records, dropped: dropped[signal], promoted: exportAll })
        )
      )
    }
    if (finished.length > 0) send("traces", finished.length, () => buildTraceRequest(resource, finished, config.rules, parents))
    if (logs.length > 0) send("logs", logs.length, () => buildLogsRequest(resource, logs, config.rules))
    await Promise.all(posts)
  }

  return {
    sampled: trace.sampled,
    provide: (effect) => Effect.provide(isolate(effect), layer),
    end: (outcome: HeraTelemetryEnd = {}) => {
      if (ended) return
      ended = true
      const slow = config.now() - startMs > config.slowThresholdMs
      const failed = (outcome.status ?? 0) >= 500 || outcome.defect === true
      const exportAll = trace.sampled || promoted || failed || slow
      if (loud.length === 0 && !(exportAll && (spans.items().length > 0 || infos.items().length > 0))) return
      // Serialization runs inside the waitUntil promise, off the response path.
      options.waitUntil(Promise.resolve().then(() => flush(exportAll)).catch(() => undefined))
    },
  }
}
