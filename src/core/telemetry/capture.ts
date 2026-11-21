import * as Context from "effect/Context"
import type { HeraTelemetryLevel } from "./types.js"

/**
 * What a Hera logger hands a finished line to while an exporting invocation runs. `log` takes the
 * entry the logger already scrubbed; the logger then skips its default console sink.
 */
export interface TelemetryLogCapture {
  readonly log: (level: HeraTelemetryLevel, entry: Readonly<Record<string, unknown>>, timeMs: number) => void
}

/** The capture of the invocation the fiber runs in; unset outside an exporting invocation. */
export const CurrentTelemetryCapture = Context.Reference<TelemetryLogCapture | undefined>(
  "@sibylline-labs/hera/CurrentTelemetryCapture",
  { defaultValue: () => undefined }
)
