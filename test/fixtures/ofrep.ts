/**
 * Logfire OFREP bulk-evaluation answers.
 *
 * Recorded Nov-07 from `POST https://logfire-us.pydantic.dev/v1/ofrep/v1/evaluate/flags` (a Logfire
 * project, read token):
 *  - `EMPTY_PROJECT`: etag header and body byte for byte before variables existed;
 *  - `FLAG_NOT_FOUND_ENTRY`: the single-flag 404 entry;
 *  - `targeted`: bulk evaluation of `hera_ofrep_probe` (boolean, v1 = `true` label `on`,
 *    v2 = `false` latest, override `org_id == ORG_A` → `on`), where `ORG_A` resolves to
 *    `true` / `TARGETING_MATCH` / `on`, `ORG_B` resolves to `false` / `STATIC` / `latest`, and
 *    each context's ETag revalidates to 304 for that context only.
 */

export const PROBE_FLAG = "hera_ofrep_probe"
export const ORG_A = "01PROBEORGA000000000000000"
export const ORG_B = "01PROBEORGB000000000000000"

export const EMPTY_PROJECT = {
  etag: '"628fcaa2c7b9f3b10c0d84a0a771ccc3"',
  body: '{"flags":[],"metadata":{"etag":"\\"628fcaa2c7b9f3b10c0d84a0a771ccc3\\""}}',
} as const

export const FLAG_NOT_FOUND_ENTRY = {
  key: PROBE_FLAG,
  errorCode: "FLAG_NOT_FOUND",
  errorDetails: `Flag '${PROBE_FLAG}' was not found`,
} as const

/** The recorded bulk answer for an org: `on` (`TARGETING_MATCH`) when `org_id == ORG_A`, else `latest` (`STATIC`). */
export function targeted(orgId: string): { readonly etag: string; readonly body: string } {
  const matched = orgId === ORG_A
  const entry = matched
    ? { key: PROBE_FLAG, value: true, variant: "on", reason: "TARGETING_MATCH", metadata: {} }
    : { key: PROBE_FLAG, value: false, variant: "latest", reason: "STATIC", metadata: {} }
  const etag = matched ? '"a0000000000000000000000000000001"' : '"b0000000000000000000000000000002"'
  return { etag, body: JSON.stringify({ flags: [entry], metadata: { etag } }) }
}
