import * as Redacted from "effect/Redacted"
import { HeraAgentTelemetry, type HeraAgentTelemetryOptions, type HeraExportReport } from "../src/server/agent/telemetry/index.js"

interface OtlpAttr {
  readonly key: string
  readonly value: { readonly stringValue?: string; readonly intValue?: string | number; readonly arrayValue?: unknown }
}
export interface OtlpSpan {
  readonly name: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly traceId: string
  readonly attributes?: ReadonlyArray<OtlpAttr>
  readonly events?: ReadonlyArray<{ readonly name: string; readonly attributes?: ReadonlyArray<OtlpAttr> }>
  readonly links?: ReadonlyArray<{ readonly attributes?: ReadonlyArray<OtlpAttr> }>
  readonly status?: { readonly message?: string }
}

export function spansOf(bodies: ReadonlyArray<string>): OtlpSpan[] {
  return bodies.flatMap(
    (body) =>
      (JSON.parse(body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> }).resourceSpans.flatMap(
        (resource) => resource.scopeSpans.flatMap((scope) => scope.spans)
      )
  )
}

export function attr(span: OtlpSpan, key: string): string | undefined {
  const found = span.attributes?.find((a) => a.key === key)
  return found === undefined ? undefined : String(found.value.stringValue ?? found.value.intValue)
}

export interface Rig {
  readonly telemetry: HeraAgentTelemetry
  readonly bodies: string[]
  readonly reports: HeraExportReport[]
  readonly settle: () => Promise<void>
  readonly spans: () => OtlpSpan[]
}

/** A telemetry instance posting to an in-process sink; `status` is the sink's answer. */
export function rig(options: Partial<HeraAgentTelemetryOptions> & { status?: number } = {}): Rig {
  const bodies: string[] = []
  const reports: HeraExportReport[] = []
  const pending: Promise<unknown>[] = []
  const { status = 200, ...rest } = options
  const telemetry = HeraAgentTelemetry.make({
    service: "test-agents",
    environment: "test",
    tenant: "org-1",
    sink: { baseUrl: "https://logfire.test", token: Redacted.make("write-token") },
    waitUntil: (p) => void pending.push(p),
    fetch: (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response("{}", { status })
    }) as unknown as typeof fetch,
    onExport: (report) => reports.push(report),
    ...rest,
  })
  return {
    telemetry,
    bodies,
    reports,
    settle: async () => {
      await Promise.all(pending)
    },
    spans: () => spansOf(bodies),
  }
}
