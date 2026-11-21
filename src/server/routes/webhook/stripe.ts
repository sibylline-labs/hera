/**
 * `HeraWebhook.stripe`: the Stripe preset over `verifyHmac`.
 *
 * Stripe sends `Stripe-Signature: t=<unix s>,v1=<hex>[,v1=<hex>…][,v0=…]` and signs the bytes
 * `${t}.${rawBody}` with HMAC-SHA-256, one `v1` per active secret during a rotation.
 */
import type * as Effect from "effect/Effect"
import type { HeraError } from "../../../core/errors/index.js"
import { verifyHmac } from "./verify-hmac.js"
import type { HeraWebhookSecret, HeraWebhookSignatureHeader } from "./types.js"

const DEFAULT_TOLERANCE_MS = 300_000

export interface HeraWebhookStripeOptions {
  /** The endpoint's `whsec_…` secret, or several (current first, then previous). */
  readonly secret: HeraWebhookSecret | ReadonlyArray<HeraWebhookSecret>
  /** How far `t` may be from the Effect clock, either way (default 5 minutes). */
  readonly toleranceMs?: number | undefined
  /** Body byte cap (default 64 KiB). */
  readonly maxBytes?: number | undefined
}

/**
 * Reads a `Stripe-Signature` value: `t` counts only when it appears exactly once (a repeated `t`
 * is ambiguous about what was signed), every `v1` is a candidate, other schemes are ignored.
 */
export function parseStripeSignature(value: string): HeraWebhookSignatureHeader {
  const timestamps: Array<string> = []
  const signatures: Array<string> = []
  for (const part of value.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const scheme = part.slice(0, eq)
    const content = part.slice(eq + 1)
    if (scheme === "t") timestamps.push(content)
    else if (scheme === "v1") signatures.push(content)
  }
  return { timestamp: timestamps.length === 1 ? timestamps[0] : undefined, signatures }
}

const encoder = new TextEncoder()

function stripePayload(timestamp: string, body: Uint8Array<ArrayBuffer>): Uint8Array {
  const prefix = encoder.encode(`${timestamp}.`)
  const signed = new Uint8Array(prefix.byteLength + body.byteLength)
  signed.set(prefix)
  signed.set(body, prefix.byteLength)
  return signed
}

/** A verifier for Stripe webhook deliveries; see `verifyHmac` for the refusal contract. */
export function stripe(
  options: HeraWebhookStripeOptions
): (request: Request) => Effect.Effect<Uint8Array<ArrayBuffer>, HeraError> {
  return verifyHmac({
    secret: options.secret,
    header: "stripe-signature",
    algo: "SHA-256",
    encoding: "hex",
    maxBytes: options.maxBytes,
    parse: parseStripeSignature,
    timestamp: {
      signed: true,
      payload: stripePayload,
      unit: "s",
      toleranceMs: options.toleranceMs ?? DEFAULT_TOLERANCE_MS,
    },
  })
}
