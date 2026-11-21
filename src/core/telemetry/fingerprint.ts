const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

/** 64-bit Fowler-Noll-Vo (1a variant) over the UTF-8 bytes of `text`, as 16 lowercase hex characters. */
function fnv1a64(text: string): string {
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK
  }
  return hash.toString(16).padStart(16, "0")
}

export interface FingerprintInput {
  /** `exception.type`: an identifier (`safeErrorName`). */
  readonly type: string
  /** The frame function names (`frameFunctions`), in order; line and column never enter. */
  readonly frames: ReadonlyArray<string>
  /** A catalogued `HeraError` code, when there is one. */
  readonly code?: string | undefined
}

/**
 * The `logfire.exception.fingerprint` Logfire Error Tracking groups issues by: a hash of the
 * type, the frame function names and the catalogued code. The message never enters, so the same
 * fault with different input text is one issue, and no caller text can reach the attribute.
 */
export function exceptionFingerprint(input: FingerprintInput): string {
  return fnv1a64([input.type, ...input.frames, input.code ?? ""].join("\n"))
}
