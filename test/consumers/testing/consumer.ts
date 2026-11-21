import "@total-typescript/ts-reset"
import "@sibylline-labs/hera/testing/bun-preload"
export * as testing from "@sibylline-labs/hera/testing"
export * as testingAgent from "@sibylline-labs/hera/testing/agent"
export * as cloudflareWorkersStub from "@sibylline-labs/hera/testing/cloudflare-workers"

import { HeraTest, type CapturedOtlpSpan, type HeraTestTelemetry } from "@sibylline-labs/hera/testing"

// `HeraTest.telemetry()` from a pure consumer: a real HeraTelemetry, its hook and sink, read back decoded.
const capture: HeraTestTelemetry = HeraTest.telemetry({ sampling: { headRate: 0 } })
export const telemetryHook = capture.hook
export const telemetrySink = capture.sink
export const firstSpanEnvironment = (spans: ReadonlyArray<CapturedOtlpSpan>) => spans[0]?.resource["deployment.environment.name"]
