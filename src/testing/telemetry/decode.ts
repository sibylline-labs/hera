/** Captured OTLP/JSON, decoded so a test reads attributes as a plain record. */

export type CapturedValue = string | number | boolean | ReadonlyArray<CapturedValue> | undefined

export interface CapturedEvent {
  readonly name: string
  readonly attributes: Readonly<Record<string, CapturedValue>>
}

/** One span as it left the process, after scrubbing; attributes decoded from OTLP `AnyValue`s. */
export interface CapturedOtlpSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string | undefined
  readonly name: string
  readonly attributes: Readonly<Record<string, CapturedValue>>
  readonly events: ReadonlyArray<CapturedEvent>
  /** OTLP status code: 0 unset, 1 ok, 2 error. */
  readonly statusCode: number
  /** The batch's resource (`service.name`, `deployment.environment.name`, ...). */
  readonly resource: Readonly<Record<string, CapturedValue>>
}

/** One log record as it left the process, after scrubbing. */
export interface CapturedOtlpLog {
  readonly severityText: string
  readonly body: CapturedValue
  readonly attributes: Readonly<Record<string, CapturedValue>>
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly resource: Readonly<Record<string, CapturedValue>>
}

type Json = Readonly<Record<string, unknown>>

function list(value: unknown): ReadonlyArray<Json> {
  return Array.isArray(value) ? (value as ReadonlyArray<Json>) : []
}

function decodeValue(value: unknown): CapturedValue {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Json
  if (typeof v["stringValue"] === "string") return v["stringValue"]
  if (typeof v["boolValue"] === "boolean") return v["boolValue"]
  if (v["intValue"] !== undefined) return Number(v["intValue"])
  if (typeof v["doubleValue"] === "number") return v["doubleValue"]
  const array = v["arrayValue"] as Json | undefined
  if (array !== undefined) return list(array["values"]).map(decodeValue)
  return undefined
}

export function decodeAttributes(attributes: unknown): Record<string, CapturedValue> {
  const out: Record<string, CapturedValue> = {}
  for (const entry of list(attributes)) out[String(entry["key"])] = decodeValue(entry["value"])
  return out
}

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

export function decodeSpans(body: Json): CapturedOtlpSpan[] {
  return list(body["resourceSpans"]).flatMap((resourceSpans) => {
    const resource = decodeAttributes((resourceSpans["resource"] as Json | undefined)?.["attributes"])
    return list(resourceSpans["scopeSpans"]).flatMap((scope) =>
      list(scope["spans"]).map((span) => ({
        traceId: String(span["traceId"]),
        spanId: String(span["spanId"]),
        parentSpanId: optionalId(span["parentSpanId"]),
        name: String(span["name"]),
        attributes: decodeAttributes(span["attributes"]),
        events: list(span["events"]).map((event) => ({ name: String(event["name"]), attributes: decodeAttributes(event["attributes"]) })),
        statusCode: Number((span["status"] as Json | undefined)?.["code"] ?? 0),
        resource,
      }))
    )
  })
}

export function decodeLogs(body: Json): CapturedOtlpLog[] {
  return list(body["resourceLogs"]).flatMap((resourceLogs) => {
    const resource = decodeAttributes((resourceLogs["resource"] as Json | undefined)?.["attributes"])
    return list(resourceLogs["scopeLogs"]).flatMap((scope) =>
      list(scope["logRecords"]).map((record) => ({
        severityText: String(record["severityText"] ?? ""),
        body: decodeValue(record["body"]),
        attributes: decodeAttributes(record["attributes"]),
        traceId: optionalId(record["traceId"]),
        spanId: optionalId(record["spanId"]),
        resource,
      }))
    )
  })
}
