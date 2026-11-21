import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { request } from "../http/client.js"
import { RateLimitedError } from "../http/errors.js"
import type { ResolvedTelemetryConfig } from "./config.js"
import type { HeraTelemetryExportOutcome } from "./types.js"

/**
 * POSTs one OTLP/JSON payload through `HeraHttp.request` (whole-exchange timeout, bounded body).
 * Any non-2xx is `rejected`: workerd answers an unreachable host with an HTTP 530, not a throw.
 * The module's one `Effect.runPromise`: `waitUntil` takes a Promise. Never rejects.
 */
export function postOtlp(
  config: ResolvedTelemetryConfig,
  signal: "traces" | "logs",
  body: string
): Promise<HeraTelemetryExportOutcome> {
  const target = config.target
  if (target === undefined) {
    return Promise.resolve("rejected")
  }
  return Effect.runPromise(
    request({
      url: `${target.baseUrl}/v1/${signal}`,
      method: "POST",
      headers: { authorization: Redacted.value(target.token), "content-type": "application/json" },
      body,
      timeoutMs: config.timeoutMs,
      maxBytes: 4096,
      onMaxBytes: "truncate",
      ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    }).pipe(
      Effect.match({
        onSuccess: (): HeraTelemetryExportOutcome => "sent",
        onFailure: (error): HeraTelemetryExportOutcome =>
          error instanceof RateLimitedError || error.reason === "HttpStatusError" ? "rejected" : "unreachable",
      })
    )
  ).catch((): HeraTelemetryExportOutcome => "unreachable")
}
