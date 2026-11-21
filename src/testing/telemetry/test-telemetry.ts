import * as Redacted from "effect/Redacted"
import { HeraTelemetry } from "../../core/telemetry/telemetry.js"
import type {
  HeraTelemetry as HeraTelemetryShape,
  HeraTelemetryConfig,
  HeraTelemetryExportReport,
  HeraTelemetryHook,
  HeraTelemetrySink,
} from "../../core/telemetry/types.js"
import { type CapturedOtlpLog, type CapturedOtlpSpan, decodeLogs, decodeSpans } from "./decode.js"

/** One POST the in-memory OTLP host received. */
export interface CapturedOtlpPost {
  readonly signal: "traces" | "logs"
  readonly headers: Headers
  readonly body: Readonly<Record<string, unknown>>
}

export interface HeraTestTelemetryOptions extends Partial<HeraTelemetryConfig> {
  /** The HTTP status the in-memory host answers with. Default `200`. */
  readonly status?: number | undefined
}

/** `HeraTest.telemetry()`: a real `HeraTelemetry` and its sink, wired to an in-memory OTLP host. */
export interface HeraTestTelemetry {
  readonly telemetry: HeraTelemetryShape
  /** Pass to `HeraAgentTelemetry.make` (with `fetch` and `waitUntil`) to capture agent spans too. */
  readonly sink: HeraTelemetrySink
  readonly fetch: typeof globalThis.fetch
  /** Collects every export; `settle()` awaits them. */
  readonly waitUntil: (promise: Promise<unknown>) => void
  /** The hook a Hera boundary (`Hera.worker`, routes, Durable Objects) takes. */
  readonly hook: HeraTelemetryHook
  readonly reports: ReadonlyArray<HeraTelemetryExportReport>
  readonly posts: ReadonlyArray<CapturedOtlpPost>
  /** Every span posted so far, in order, as it left: scrubbed, promoted, encoded. */
  readonly spans: () => ReadonlyArray<CapturedOtlpSpan>
  /** Every log record posted so far, in order. */
  readonly logs: () => ReadonlyArray<CapturedOtlpLog>
  /** Awaits every promise handed to `waitUntil`, including ones those exports schedule. */
  readonly settle: () => Promise<void>
}

const BASE_URL = "https://logfire.test"

function signalOf(input: string | URL | Request): "traces" | "logs" | undefined {
  const url = input instanceof Request ? input.url : String(input)
  const path = new URL(url).pathname
  return path === "/v1/traces" ? "traces" : path === "/v1/logs" ? "logs" : undefined
}

/**
 * The capture runs everything a real export runs (scrubbing, tail-promotion, OTLP encoding, the
 * POST through `HeraHttp`) and stops at the network: `fetch` records the body instead of sending it.
 * Defaults: `environment: "test"`, `sampling.headRate: 1` (every invocation exports; pass `0` to
 * see only what tail-promotion keeps).
 */
export function makeTestTelemetry(options: HeraTestTelemetryOptions = {}): HeraTestTelemetry {
  const { status = 200, ...overrides } = options
  const posts: CapturedOtlpPost[] = []
  const reports: HeraTelemetryExportReport[] = []
  const pending: Array<Promise<unknown>> = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const signal = signalOf(input)
    if (signal === undefined) return new Response("not an OTLP path", { status: 404 })
    posts.push({
      signal,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    })
    return new Response("{}", { status })
  }) as typeof globalThis.fetch
  const sink: HeraTelemetrySink = { baseUrl: BASE_URL, token: Redacted.make("hera-test-write-token") }
  const telemetry = HeraTelemetry.make({
    service: "hera-test",
    environment: "test",
    sink,
    fetch,
    ...overrides,
    sampling: { headRate: 1, ...overrides.sampling },
    onExport: (report) => {
      reports.push(report)
      overrides.onExport?.(report)
    },
  })
  const waitUntil = (promise: Promise<unknown>) => void pending.push(promise)
  return {
    telemetry,
    sink,
    fetch,
    waitUntil,
    hook: { telemetry, waitUntil },
    reports,
    posts,
    spans: () => posts.filter((post) => post.signal === "traces").flatMap((post) => decodeSpans(post.body)),
    logs: () => posts.filter((post) => post.signal === "logs").flatMap((post) => decodeLogs(post.body)),
    settle: async () => {
      while (pending.length > 0) await pending.shift()
    },
  }
}
