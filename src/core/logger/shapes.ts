import { REDACTED_VALUE } from "./types.js"

const ULID = "[0-9A-HJKMNP-TV-Z]{26}"
/** The base64url run a credential's secret is drawn from. Unbounded: a secret cut short is still a secret. */
const SECRET_RUN = "[A-Za-z0-9_-]+"

/**
 * Credential-shaped runs, replaced in place wherever they sit in a string. A runtime
 * error quotes its input (bun's `JSON.parse` error prints a whole token), so a credential arrives
 * inside a message under a field no key rule can see. Replacing the run, not the string, keeps the
 * rest of the message readable.
 *
 *   sib_<ULID>_<secret>        a `sib_` bearer token
 *   lin_<kind>_<secret>        a Linear OAuth token, API key or code
 *   Bearer <credential>        an Authorization value, whatever its shape (the whole non-space run)
 *   64+ hex characters         a SHA-256 token or session hash
 *
 * The heads are fixed, so a bare `sib_<org>` limiter key or a 40-hex git SHA stays readable. A head
 * glued to a field prefix (`key_sib_...`) still matches: only a letter or digit before it does not.
 */
export const CREDENTIAL_SHAPES: ReadonlyArray<RegExp> = [
  new RegExp(`(?<![A-Za-z0-9])sib_${ULID}_${SECRET_RUN}`, "g"),
  /(?<![A-Za-z0-9])lin_[A-Za-z0-9]{1,16}_[A-Za-z0-9_-]+/g,
  /\bBearer\s+\S+/gi,
  /[0-9a-f]{64,}/gi,
]

function asGlobal(shape: RegExp): RegExp {
  return shape.global ? shape : new RegExp(shape.source, `${shape.flags}g`)
}

/**
 * `text` with every run matching Hera's {@link CREDENTIAL_SHAPES} or a consumer's `extra` shapes
 * replaced by `[REDACTED]`. A consumer shape without the `g` flag is applied globally anyway.
 */
export function scrubCredentialRuns(
  text: string,
  extra: ReadonlyArray<RegExp> = []
): string {
  let out = text
  for (const shape of extra) {
    out = out.replace(asGlobal(shape), REDACTED_VALUE)
  }
  for (const shape of CREDENTIAL_SHAPES) {
    out = out.replace(shape, REDACTED_VALUE)
  }
  return out
}
