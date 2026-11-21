import type * as Redacted from "effect/Redacted"
import type { Keyring } from "../../../core/config/index.js"

/**
 * One HMAC secret: a string (its UTF-8 bytes, one trailing `\r?\n` stripped, empty = unset) or a
 * versioned `Keyring` (every entry's decoded bytes), either one bare or `Redacted`.
 */
export type HeraWebhookSecret =
  | string
  | Redacted.Redacted<string>
  | Keyring
  | Redacted.Redacted<Keyring>

export type HeraWebhookAlgo = "SHA-256" | "SHA-384" | "SHA-512"

export type HeraWebhookEncoding = "hex" | "base64"

interface HeraWebhookTimestampBase {
  /** Unit of the timestamp the sender signs (default `"ms"`). */
  readonly unit?: "ms" | "s" | undefined
  /** How far the timestamp may be from the Effect clock, either way. */
  readonly toleranceMs: number
}

/**
 * What `HeraWebhookOptions.parse` reads out of the signature header: the signed timestamp (when the
 * header carries one) and every candidate signature, each still in its header spelling.
 */
export interface HeraWebhookSignatureHeader {
  readonly timestamp?: string | undefined
  readonly signatures: ReadonlyArray<string>
}

/**
 * Where the delivery's timestamp lives: its own header (decimal digits only), the signature header
 * itself (`signed`, through `parse`), or the signed body, read only after the signature verifies
 * (`read` returning `undefined` = absent).
 *
 * A header timestamp is only a replay defence when the HMAC covers it, so the header and signed
 * arms require `payload`: the bytes the sender signs, built from the raw timestamp and the body
 * (Slack: `v0:${timestamp}:${body}`, Stripe: `${t}.${body}`). The signature is verified over
 * `payload(...)`, never the bare body.
 */
export type HeraWebhookTimestampOption =
  | (HeraWebhookTimestampBase & {
      readonly header: string
      readonly payload: (timestamp: string, body: Uint8Array<ArrayBuffer>) => Uint8Array
      readonly read?: never
      readonly signed?: never
    })
  | (HeraWebhookTimestampBase & {
      readonly read: (body: Uint8Array<ArrayBuffer>) => number | undefined
      readonly header?: never
      readonly signed?: never
    })
  | (HeraWebhookTimestampBase & {
      /** The timestamp is the one `HeraWebhookOptions.parse` returned; it needs `parse`. */
      readonly signed: true
      readonly payload: (timestamp: string, body: Uint8Array<ArrayBuffer>) => Uint8Array
      readonly header?: never
      readonly read?: never
    })

export interface HeraWebhookOptions {
  /** One secret or several (current first, then previous); any of them verifies. */
  readonly secret: HeraWebhookSecret | ReadonlyArray<HeraWebhookSecret>
  /** The signature header name. */
  readonly header: string
  readonly algo?: HeraWebhookAlgo | undefined
  readonly encoding?: HeraWebhookEncoding | undefined
  /** Exact prefix stripped from the header value before decoding (e.g. `"sha256="`). */
  readonly prefix?: string | undefined
  /**
   * Reads a combined signature header (a timestamp plus several signatures in one value). Each
   * returned signature is decoded with `encoding` and `prefix`; undecodable ones are dropped. More
   * than 8 signatures, none usable, or `undefined` is `malformed_signature`, before any key import.
   */
  readonly parse?: ((value: string) => HeraWebhookSignatureHeader | undefined) | undefined
  /** Body byte cap, checked before any HMAC (default 64 KiB). */
  readonly maxBytes?: number | undefined
  readonly timestamp?: HeraWebhookTimestampOption | undefined
}

/** Why a delivery was refused: a closed set a caller may log, never sent on the wire. */
export type HeraWebhookRefusalReason =
  | "unconfigured"
  | "too_large"
  | "missing_signature"
  | "malformed_signature"
  | "bad_signature"
  | "missing_timestamp"
  | "stale"

/**
 * The `cause` of every verifier refusal. It carries the reason only: never a secret, signature or
 * body byte, so serialising it is always safe.
 */
export class HeraWebhookRefusal {
  readonly _tag = "HeraWebhookRefusal" as const

  constructor(readonly reason: HeraWebhookRefusalReason) {}

  toString(): string {
    return `HeraWebhookRefusal(${this.reason})`
  }

  toJSON(): { readonly _tag: "HeraWebhookRefusal"; readonly reason: HeraWebhookRefusalReason } {
    return { _tag: this._tag, reason: this.reason }
  }
}
