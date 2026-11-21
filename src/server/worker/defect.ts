import { describeException } from "../../core/telemetry/exception.js"
import { safeErrorName } from "../../core/telemetry/stack.js"
import { GITLEAKS_SHAPES } from "../../core/logger/gitleaks.js"
import { extractSafeDefectName } from "../routes/response.js"

/**
 * What a boundary rethrows in place of a caught defect: a fixed message, so the runtime (and
 * Cloudflare's crash backstop) sees that something failed and retries, but never the raw text
 * The original is logged scrubbed before this is thrown.
 */
export class HeraBoundaryDefect extends Error {
  override readonly name = "HeraBoundaryDefect"
  readonly defectName: string
  readonly fingerprint: string

  constructor(defectName: string, fingerprint: string) {
    super("Hera boundary caught a defect; details are in the scrubbed log record")
    this.defectName = defectName
    this.fingerprint = fingerprint
  }
}

/** The log fields a caught defect may carry: its class name and the scrubbed-stack fingerprint. */
export interface SafeDefectFields {
  readonly defect_name: string
  readonly exception_fingerprint: string
}

export function safeDefectFields(defect: unknown): SafeDefectFields {
  return {
    // A `_tag` or constructor name is caller-controlled text: only an identifier passes.
    defect_name: safeErrorName(extractSafeDefectName(defect)),
    exception_fingerprint: describeException(defect, { secretShapes: GITLEAKS_SHAPES }).fingerprint,
  }
}

/** `defect` as the sanitized error a boundary rethrows; a `HeraBoundaryDefect` passes through. */
export function sanitizeDefect(defect: unknown): HeraBoundaryDefect {
  if (defect instanceof HeraBoundaryDefect) return defect
  const fields = safeDefectFields(defect)
  return new HeraBoundaryDefect(fields.defect_name, fields.exception_fingerprint)
}
