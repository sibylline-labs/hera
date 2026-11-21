import * as Redacted from "effect/Redacted"
import { HeraTelemetry, type HeraTelemetryConfig, type HeraTelemetryExportReport } from "../src/core/telemetry/index.js"

export interface Posted {
  readonly path: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

/** A telemetry wired to an in-memory OTLP host; `settle()` awaits every `waitUntil` promise. */
export function makeTelemetryHarness(overrides: Partial<HeraTelemetryConfig> & { status?: number } = {}) {
  const posts: Array<Posted> = []
  const reports: Array<HeraTelemetryExportReport> = []
  const pending: Array<Promise<unknown>> = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    posts.push({
      path: new URL(String(input)).pathname,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    })
    return new Response("{}", { status: overrides.status ?? 200 })
  }) as typeof globalThis.fetch
  const telemetry = HeraTelemetry.make({
    service: "svc",
    environment: "test",
    version: "v1",
    sink: { baseUrl: "https://logfire.test/", token: Redacted.make("write-token") },
    fetch,
    random: () => 0.5,
    onExport: (report) => void reports.push(report),
    ...overrides,
  })
  const waitUntil = (promise: Promise<unknown>) => void pending.push(promise)
  return {
    telemetry,
    posts,
    reports,
    waitUntil,
    settle: async () => {
      while (pending.length > 0) await pending.shift()
    },
  }
}

type Json = Record<string, unknown>

export function spansOf(post: Posted | undefined): ReadonlyArray<Json> {
  const resource = (post?.body.resourceSpans as ReadonlyArray<Json> | undefined)?.[0]
  return ((resource?.scopeSpans as ReadonlyArray<Json> | undefined)?.[0]?.spans as ReadonlyArray<Json>) ?? []
}

export function logsOf(post: Posted | undefined): ReadonlyArray<Json> {
  const resource = (post?.body.resourceLogs as ReadonlyArray<Json> | undefined)?.[0]
  return ((resource?.scopeLogs as ReadonlyArray<Json> | undefined)?.[0]?.logRecords as ReadonlyArray<Json>) ?? []
}

export function attr(record: Json, key: string): unknown {
  const found = (record.attributes as ReadonlyArray<{ key: string; value: Json }>).find((a) => a.key === key)
  return found === undefined ? undefined : Object.values(found.value)[0]
}
