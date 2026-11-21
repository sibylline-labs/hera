import type { ScrubRules } from "../logger/types.js"
import { type OtlpKeyValue, toAnyValue, toAttributes, unixNano } from "./otlp-values.js"
import type { CapturedLogRecord, HeraTelemetryLevel } from "./types.js"

const SEVERITY: Readonly<Record<HeraTelemetryLevel, readonly [number, string]>> = {
  debug: [5, "DEBUG"],
  info: [9, "INFO"],
  warn: [13, "WARN"],
  error: [17, "ERROR"],
}

const HEX_TRACE = /^[0-9a-f]{32}$/
const HEX_SPAN = /^[0-9a-f]{16}$/

/** An OTLP/JSON `ExportLogsServiceRequest` for `records`, every string scrubbed again on the way out. */
export function buildLogsRequest(
  resource: ReadonlyArray<OtlpKeyValue>,
  records: ReadonlyArray<CapturedLogRecord>,
  rules: ScrubRules
): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: resource },
        scopeLogs: [
          {
            scope: { name: "@sibylline-labs/hera" },
            logRecords: records.map((record) => {
              const [severityNumber, severityText] = SEVERITY[record.level]
              const time = unixNano(record.timeMs)
              return {
                timeUnixNano: time,
                observedTimeUnixNano: time,
                severityNumber,
                severityText,
                body: toAnyValue(record.body, rules) ?? { stringValue: "" },
                attributes: toAttributes(record.attributes, rules),
                ...(record.traceId !== undefined && HEX_TRACE.test(record.traceId) ? { traceId: record.traceId } : {}),
                ...(record.spanId !== undefined && HEX_SPAN.test(record.spanId) ? { spanId: record.spanId } : {}),
              }
            }),
          },
        ],
      },
    ],
  }
}
