import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import { HeraConfig } from "../../core/config/index.js"
import {
  HeraError,
  type HeraErrorStatus,
  type HeraWireErrorCode,
  resolveCatalogPublicMessage,
  sanitizeErrorFields,
} from "../../core/errors/index.js"
import {
  HeraSchema,
  type HeraSchemaIssue,
  type OrgId,
  RequestId,
} from "../../core/schema/index.js"
import { extractSafeDefectName } from "../routes/response.js"
import type { HeraBoundaryDefectLog } from "../routes/types.js"
import type { HeraRpcFail, HeraRpcResult } from "./types.js"

export function normalizeServiceSlug(service: string | undefined): string {
  if (service === undefined || service.trim().length === 0) {
    return "service"
  }
  const normalized = service
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return normalized.length > 0 ? normalized : "service"
}

export function serviceUnavailableCode(
  service: string | undefined
): `${string}_unavailable` {
  return `${normalizeServiceSlug(service)}_unavailable`
}

export function toPlainIssues(
  issues: ReadonlyArray<HeraSchemaIssue> | undefined
): ReadonlyArray<HeraSchemaIssue> | undefined {
  if (issues === undefined || issues.length === 0) {
    return undefined
  }
  return issues.map((issue) => ({
    path: Array.isArray(issue.path) ? [...issue.path] : [],
    message: String(issue.message),
    code: issue.code ?? "invalid_type",
    expected: String(issue.expected ?? ""),
  }))
}

export function toPlainValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value)
  }
  // Structured clone carries binary values as they are; walking their entries would drop the bytes.
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => toPlainValue(item))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        v !== undefined &&
        typeof v !== "function" &&
        typeof v !== "symbol" &&
        !(v instanceof Error)
      ) {
        out[k] = toPlainValue(v)
      }
    }
    return out
  }
  return String(value)
}

export function toPlainFailPojo(
  err: HeraError,
  fallbackRequestId?: RequestId
): HeraRpcFail {
  const reqId = err.requestId ?? fallbackRequestId
  const plainIssues = toPlainIssues(err.issues)
  const plainFields =
    err.fields !== undefined
      ? (toPlainValue(sanitizeErrorFields(err.fields)) as
          | Readonly<Record<string, unknown>>
          | undefined)
      : undefined

  return {
    ok: false,
    status: err.httpStatus,
    code: err.code,
    error: err.code,
    message: err.publicMessage,
    ...(reqId !== undefined ? { requestId: String(reqId) } : {}),
    ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
    ...(plainIssues !== undefined ? { issues: plainIssues } : {}),
    ...(plainFields !== undefined && Object.keys(plainFields).length > 0
      ? { fields: plainFields }
      : {}),
  }
}

/**
 * Checks whether an unknown value is a `HeraRpcResult` wire envelope.
 */
export function isHeraRpcResult(
  u: unknown
): u is HeraRpcResult<unknown, HeraWireErrorCode, HeraErrorStatus> {
  if (typeof u !== "object" || u === null || !("ok" in u)) {
    return false
  }
  const candidate = u as { readonly ok?: unknown; readonly status?: unknown }
  if (candidate.ok === true) {
    return "value" in u
  }
  if (candidate.ok === false) {
    return typeof candidate.status === "number"
  }
  return false
}

export function exitToRpcResult<A>(
  exit: Exit.Exit<A, unknown>,
  options: {
    readonly requestId: RequestId
    readonly resolvedOrgId: OrgId | undefined
    readonly service: string
    readonly spanName: string
    readonly unavailableCode: `${string}_unavailable`
    readonly onDefect?: ((entry: HeraBoundaryDefectLog) => void) | undefined
  }
): HeraRpcResult<A> {
  if (Exit.isSuccess(exit)) {
    return {
      ok: true,
      value: toPlainValue(exit.value) as A,
    }
  }

  const cause = exit.cause
  const hasDefectOrInterrupt =
    Cause.hasDies(cause) || Cause.hasInterrupts(cause)

  if (!hasDefectOrInterrupt) {
    const failOpt = Cause.findErrorOption(cause)
    if (Option.isSome(failOpt)) {
      const err = failOpt.value
      if (HeraError.is(err)) {
        return toPlainFailPojo(err, options.requestId)
      }
      if (HeraError.isDefinedError(err)) {
        return toPlainFailPojo(
          err.toHeraError({ requestId: options.requestId }),
          options.requestId
        )
      }
      if (HeraSchema.isHeraSchemaError(err)) {
        return toPlainFailPojo(
          HeraError.fromSchemaError(
            err,
            "Invalid RPC input payload",
            "invalid_rpc_input"
          ),
          options.requestId
        )
      }
      if (err instanceof HeraConfig.HeraConfigError) {
        return toPlainFailPojo(HeraError.fromConfigError(err), options.requestId)
      }
    }
  }

  const dieReasons = cause.reasons.filter(Cause.isDieReason)
  const firstDefect =
    dieReasons.length > 0
      ? dieReasons[0]?.defect
      : Option.getOrUndefined(Cause.findErrorOption(cause))

  const defectLog: HeraBoundaryDefectLog = {
    level: "error",
    event: "hera.boundary.defect",
    boundary: "rpc",
    service: options.service,
    operation: options.spanName,
    request_id: options.requestId,
    ...(options.resolvedOrgId !== undefined
      ? { org_id: options.resolvedOrgId }
      : {}),
    defect_kind: Cause.hasInterrupts(cause)
      ? "interrupt"
      : Cause.hasDies(cause)
        ? "die"
        : "uncatalogued",
    defect_name: extractSafeDefectName(firstDefect),
  }

  options.onDefect?.(defectLog)

  return {
    ok: false,
    status: 503,
    code: options.unavailableCode,
    error: options.unavailableCode,
    message: resolveCatalogPublicMessage(options.unavailableCode, 503),
    requestId: String(options.requestId),
  }
}
