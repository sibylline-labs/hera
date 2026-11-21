import * as Context from "effect/Context"

export { formatTraceparent, parseTraceparent } from "../../core/telemetry/traceparent.js"

/** The W3C `baggage` size limit; a longer value is dropped whole, never truncated. */
export const MAX_BAGGAGE_LENGTH = 8192

/** An opaque `baggage` value that may be forwarded, or `undefined` when it must be dropped. */
export function normalizeBaggage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BAGGAGE_LENGTH) {
    return undefined
  }
  return /[\r\n]/.test(value) ? undefined : value
}

/**
 * The inbound W3C `baggage` of the RPC call the fiber serves. `Hera.rpcMethod` sets it and
 * `Hera.rpcClient` forwards it. It is opaque: never logged and never a span attribute.
 */
export const CurrentRpcBaggage = Context.Reference<string | undefined>(
  "@sibylline-labs/hera/CurrentRpcBaggage",
  { defaultValue: () => undefined }
)
