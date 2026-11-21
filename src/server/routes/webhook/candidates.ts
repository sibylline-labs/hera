/**
 * Pure helper of `HeraWebhook.verifyHmac` for a combined signature header: the decoded candidate
 * set. The count is capped on the raw list, before any decode or key import, so a header cannot
 * make the verifier do unbounded HMAC work.
 */
import { decodeSignature } from "./signature.js"
import type { HeraWebhookAlgo, HeraWebhookEncoding } from "./types.js"

export const MAX_SIGNATURE_CANDIDATES = 8

/**
 * The digest bytes of every decodable signature, or `undefined` when there are more than
 * `MAX_SIGNATURE_CANDIDATES` or none decodes.
 */
export function decodeCandidates(
  signatures: ReadonlyArray<string>,
  algo: HeraWebhookAlgo,
  encoding: HeraWebhookEncoding,
  prefix: string
): ReadonlyArray<Uint8Array<ArrayBuffer>> | undefined {
  if (signatures.length > MAX_SIGNATURE_CANDIDATES) return undefined
  const decoded: Array<Uint8Array<ArrayBuffer>> = []
  for (const value of signatures) {
    const bytes = decodeSignature(value, algo, encoding, prefix)
    if (bytes !== undefined) decoded.push(bytes)
  }
  return decoded.length === 0 ? undefined : decoded
}
