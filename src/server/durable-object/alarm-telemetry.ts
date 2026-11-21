import * as Effect from "effect/Effect"
import type { HeraLogger } from "../../core/logger/index.js"
import type { HeraTelemetry } from "../../core/telemetry/types.js"
import { safeDefectFields, sanitizeDefect } from "../worker/defect.js"

/**
 * Runs one alarm pass as a telemetry invocation (when the object has telemetry) under a
 * `<service>.alarm` span. A rejected pass is logged scrubbed and rethrown as a fixed-message
 * `HeraBoundaryDefect`, so workerd still retries the alarm but never sees raw error text.
 */
export async function runAlarmInvocation(options: {
  readonly telemetry: HeraTelemetry | undefined
  readonly waitUntil: (promise: Promise<unknown>) => void
  readonly service: string
  readonly logger: HeraLogger
  readonly program: Effect.Effect<void, never, never>
  readonly run: (program: Effect.Effect<void, never, never>) => Promise<void>
}): Promise<void> {
  const invocation = options.telemetry?.begin({ name: `${options.service}.alarm`, source: "internal", waitUntil: options.waitUntil })
  const traced = Effect.withSpan(options.program, `${options.service}.alarm`)
  try {
    await options.run(invocation === undefined ? traced : invocation.provide(traced))
    invocation?.end()
  } catch (defect) {
    const fields = safeDefectFields(defect)
    try {
      await options.run(
        (invocation === undefined ? (e: Effect.Effect<void>) => e : invocation.provide)(
          options.logger.error("hera.alarm.defect", { service: options.service, ...fields })
        )
      )
    } catch {
      // The log line is best effort; the rethrow below still reaches the runtime.
    }
    invocation?.end({ defect: true })
    throw sanitizeDefect(defect)
  }
}
