import type { TelemetryCarrier } from "@earendil-works/pi-telemetry"
import { parseTraceparent } from "../../../core/telemetry/traceparent.js"

export const CONVERSATION_KEY = "hera.conv"
/**
 * The span a child of the carried span parents under: the nearest span sure to export (empty for
 * none). Pi stores carriers (a task's `trace`) and reads them back in a later isolate, which cannot
 * tell whether the carried span, or a phase above it, was dropped.
 */
export const EXPORT_PARENT_KEY = "hera.ep"

/**
 * A position in a trace: the trace to join, the span to parent under (none at a root), the nearest
 * span sure to export (what a carrier names), and the conversation id to carry.
 */
export interface Scope {
  readonly parent: { readonly traceId: string; readonly spanId: string | undefined } | undefined
  readonly exported: string | undefined
  readonly conv: string | undefined
}

export const ROOT_SCOPE: Scope = { parent: undefined, exported: undefined, conv: undefined }

/** The W3C `traceparent` of a span, written by hand so no propagator is needed, with the export parent beside it. */
export function injectCarrier(
  span: { readonly traceId: string; readonly spanId: string },
  conv: string | undefined,
  exportParent: string | undefined
): TelemetryCarrier {
  const carrier: TelemetryCarrier = { traceparent: `00-${span.traceId}-${span.spanId}-01`, [EXPORT_PARENT_KEY]: exportParent ?? "" }
  if (conv !== undefined) carrier[CONVERSATION_KEY] = conv
  return carrier
}

/**
 * The scope a carrier names, or `undefined` for an absent or malformed one (the root then applies).
 * A carrier Hera wrote parents under its export parent; any other carrier (a caller's own span)
 * parents under the span it names.
 */
export function extractCarrier(carrier: TelemetryCarrier | undefined): Scope | undefined {
  const remote = parseTraceparent(carrier?.["traceparent"])
  if (remote === undefined) return undefined
  const exportParent = carrier?.[EXPORT_PARENT_KEY]
  const spanId = exportParent === undefined ? remote.spanId : /^[0-9a-f]{16}$/.test(exportParent) ? exportParent : undefined
  return { parent: { traceId: remote.traceId, spanId }, exported: spanId, conv: carrier?.[CONVERSATION_KEY] }
}
