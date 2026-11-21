import { readBytesBounded } from "./body-reader.js"

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`gunzip limit must be a non-negative safe integer, got ${limit}`)
  }
}

/**
 * `gzipped` decoded, or `null` once the output would pass `limit` bytes.
 *
 * A small gzip body can inflate to hundreds of MiB, so the decoder's stream is read through
 * `readBytesBounded` and cancelled at the limit: at most `limit` bytes plus one decoder chunk are
 * ever held. Output of exactly `limit` bytes is accepted. Corrupt gzip rejects; `null` means only
 * "over the limit". A `limit` that is not a non-negative safe integer throws `RangeError`.
 */
export async function gunzipBounded(
  gzipped: Uint8Array,
  limit: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  assertLimit(limit)
  // `new Uint8Array(view)` copies into a fresh ArrayBuffer, the `BlobPart` the DOM lib accepts.
  const decoded = new Blob([new Uint8Array(gzipped)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
  const { bytes, truncated } = await readBytesBounded(decoded, limit)
  return truncated ? null : bytes
}

/**
 * Standard (padded, `atob`) base64 of gzip, decoded as `gunzipBounded`: the `gzip+base64`
 * encoding an eris artifact copy carries. Invalid base64 rejects.
 */
export async function gunzipBase64Bounded(
  base64: string,
  limit: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  assertLimit(limit)
  return gunzipBounded(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), limit)
}
