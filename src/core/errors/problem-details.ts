import type { HeraSchemaIssue } from "../schema/index.js"
import {
  type HeraErrorCode,
  type HeraErrorStatus,
  resolveCatalogPublicMessage,
} from "./catalog.js"
import type { HeraWireErrorCode } from "./domain-code.js"
import { RESERVED_ENVELOPE_KEYS } from "./sanitizers.js"
import {
  HERA_PROBLEM_CONTENT_TYPE,
  HERA_PROBLEM_TYPE_PREFIX,
  type HeraErrorResponseOptions,
  type HeraProblemDetails,
} from "./types.js"

export interface ProblemDetailsSource {
  readonly code: HeraWireErrorCode
  readonly httpStatus: HeraErrorStatus
  readonly publicMessage: string
  readonly issues?: ReadonlyArray<HeraSchemaIssue> | undefined
  readonly requestId?: string | undefined
  readonly retryAfter?: number | undefined
  readonly fields?: Readonly<Record<string, unknown>> | undefined
}

/**
 * Builds a value-stripped RFC 7807 `HeraProblemDetails` payload from a normalized error source.
 * `title` is the catalog message for the code (stable per `type`); `detail` is this occurrence's message.
 */
export function buildProblemDetails(
  source: ProblemDetailsSource,
  options?: { readonly requestId?: string | undefined }
): HeraProblemDetails {
  const reqId = options?.requestId ?? source.requestId
  return {
    type: `${HERA_PROBLEM_TYPE_PREFIX}${source.code}`,
    title: resolveCatalogPublicMessage(source.code, source.httpStatus),
    status: source.httpStatus,
    detail: source.publicMessage,
    code: source.code,
    ...(source.issues !== undefined ? { issues: source.issues } : {}),
    ...(reqId !== undefined ? { request_id: reqId } : {}),
    ...(source.retryAfter !== undefined
      ? { retry_after: source.retryAfter }
      : {}),
    ...(source.fields !== undefined ? { fields: source.fields } : {}),
  }
}

/**
 * Serializes a `HeraProblemDetails` payload into an `application/problem+json` `Response` with
 * closed headers. This is the single serializer for every Hera boundary error.
 */
export function serializeProblemResponse(
  problem: HeraProblemDetails,
  options?: HeraErrorResponseOptions
): Response {
  const topLevelExtras: Record<string, unknown> = {}
  if (problem.fields !== undefined) {
    for (const [k, v] of Object.entries(problem.fields)) {
      if (!RESERVED_ENVELOPE_KEYS.has(k)) {
        topLevelExtras[k] = v
      }
    }
  }

  const bodyPayload: HeraProblemDetails & Record<string, unknown> = {
    ...problem,
    ...topLevelExtras,
  }

  const headers = new Headers({
    "content-type": HERA_PROBLEM_CONTENT_TYPE,
    "cache-control": "no-store",
  })
  if (problem.status === 401) {
    headers.set("www-authenticate", "Bearer")
  }
  if (problem.retry_after !== undefined) {
    headers.set(
      "retry-after",
      String(Math.max(1, Math.ceil(problem.retry_after)))
    )
  }
  if (problem.request_id !== undefined) {
    headers.set("x-request-id", problem.request_id)
  }
  if (options?.headers !== undefined) {
    for (const [k, v] of Object.entries(options.headers)) {
      headers.set(k, v)
    }
  }

  return new Response(JSON.stringify(bodyPayload), {
    status: problem.status,
    headers,
  })
}
