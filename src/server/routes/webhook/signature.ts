/**
 * Pure helpers of `HeraWebhook.verifyHmac`: signature decoding, the key set, timestamp parsing.
 *
 * Invariants:
 *  - A signature decodes to exactly the algorithm's digest length or not at all, so a truncated,
 *    padded or prefixed value is refused before any key is imported, and a short digest cannot
 *    match a prefix.
 *  - A string secret loses ONE trailing line ending (`HeraConfig.stripTrailingNewline`); a second
 *    is part of the secret. An empty string is unset, never a key (a zero-length HMAC key is not
 *    importable anyway).
 *  - A timestamp that is absent, not decimal digits, or not finite is never "within tolerance".
 */
import * as Redacted from "effect/Redacted"
import { Keyring, stripTrailingNewline } from "../../../core/config/index.js"
import type {
  HeraWebhookAlgo,
  HeraWebhookEncoding,
  HeraWebhookSecret,
} from "./types.js"

export const DIGEST_BYTES: Readonly<Record<HeraWebhookAlgo, number>> = {
  "SHA-256": 32,
  "SHA-384": 48,
  "SHA-512": 64,
}

const HEX = /^[0-9a-fA-F]+$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const DECIMAL = /^[0-9]{1,16}$/

function decodeHex(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (value.length % 2 !== 0 || !HEX.test(value)) return undefined
  const bytes = new Uint8Array(value.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (value.length % 4 !== 0 || !BASE64.test(value)) return undefined
  const binary = atob(value)
  // One MAC, one spelling: a value whose unused low bits differ decodes to the same bytes.
  if (btoa(binary) !== value) return undefined
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * The digest bytes a header value carries, or `undefined` when it lacks the exact `prefix`, is not
 * valid `encoding`, or does not decode to the digest length of `algo`.
 */
export function decodeSignature(
  value: string,
  algo: HeraWebhookAlgo,
  encoding: HeraWebhookEncoding,
  prefix: string
): Uint8Array<ArrayBuffer> | undefined {
  if (!value.startsWith(prefix)) return undefined
  const encoded = value.slice(prefix.length)
  const bytes = encoding === "hex" ? decodeHex(encoded) : decodeBase64(encoded)
  return bytes !== undefined && bytes.byteLength === DIGEST_BYTES[algo] ? bytes : undefined
}

function keysOf(secret: HeraWebhookSecret): ReadonlyArray<Uint8Array<ArrayBuffer>> {
  const unwrapped: unknown = Redacted.isRedacted(secret)
    ? Redacted.value(secret as Redacted.Redacted<unknown>)
    : secret
  if (unwrapped instanceof Keyring) {
    return unwrapped.entries.map((entry) => Uint8Array.from(entry.key))
  }
  if (typeof unwrapped !== "string") return []
  const bytes = new Uint8Array(new TextEncoder().encode(stripTrailingNewline(unwrapped)))
  return bytes.byteLength === 0 ? [] : [bytes]
}

/** Every usable HMAC key in the set, in order; empty when nothing is configured. */
export function secretKeyBytes(
  secret: HeraWebhookSecret | ReadonlyArray<HeraWebhookSecret>
): ReadonlyArray<Uint8Array<ArrayBuffer>> {
  return isSecretList(secret) ? secret.flatMap(keysOf) : keysOf(secret)
}

function isSecretList(
  secret: HeraWebhookSecret | ReadonlyArray<HeraWebhookSecret>
): secret is ReadonlyArray<HeraWebhookSecret> {
  return Array.isArray(secret)
}

/** A header timestamp in milliseconds; `NaN` when it is not decimal digits. */
export function parseHeaderTimestamp(value: string, unit: "ms" | "s"): number {
  if (!DECIMAL.test(value)) return Number.NaN
  const parsed = Number(value)
  return unit === "s" ? parsed * 1000 : parsed
}

/**
 * Whether `timestampMs` is within `toleranceMs` of `nowMs`, in either direction. A non-finite
 * argument is outside: every comparison with `NaN` is false, so it must not read as "not stale".
 */
export function withinTolerance(timestampMs: number, nowMs: number, toleranceMs: number): boolean {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs) || !Number.isFinite(toleranceMs)) {
    return false
  }
  return Math.abs(nowMs - timestampMs) <= toleranceMs
}
