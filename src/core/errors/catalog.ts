import type { HeraWireErrorCode } from "./domain-code.js"

/**
 * Closed HTTP status code union for the Hera error catalog.
 */
export type HeraErrorStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 405
  | 409
  | 412
  | 413
  | 422
  | 429
  | 500
  | 502
  | 503

/**
 * Runtime list of valid `HeraErrorStatus` values.
 */
export const HERA_ERROR_STATUSES: ReadonlyArray<HeraErrorStatus> = [
  400, 401, 402, 403, 404, 405, 409, 412, 413, 422, 429, 500, 502, 503,
] as const

export function isHeraErrorStatus(u: unknown): u is HeraErrorStatus {
  return (
    typeof u === "number" &&
    (HERA_ERROR_STATUSES as ReadonlyArray<number>).includes(u)
  )
}

/**
 * Closed catalog of canonical Hera refusal codes with their default HTTP status
 * and public-safe refusal message.
 */
export const HERA_ERROR_CATALOG = {
  // 400 Bad Request / Decode Refusals
  bad_request: { status: 400, publicMessage: "Bad request" },
  invalid_request: { status: 400, publicMessage: "Invalid request payload" },
  invalid_request_body: { status: 400, publicMessage: "Invalid request body" },
  invalid_body: { status: 400, publicMessage: "Invalid request body" },
  invalid_query: { status: 400, publicMessage: "Invalid query parameters" },
  invalid_headers: { status: 400, publicMessage: "Invalid request headers" },
  invalid_path_params: { status: 400, publicMessage: "Invalid path parameters" },
  invalid_params: { status: 400, publicMessage: "Invalid path parameters" },
  invalid_json: { status: 400, publicMessage: "Malformed JSON request body" },
  invalid_rpc_input: { status: 400, publicMessage: "Invalid RPC input payload" },
  invalid_cursor: { status: 400, publicMessage: "Invalid pagination cursor" },
  invalid_subject: { status: 400, publicMessage: "Invalid subject identifier" },
  agent_tool_input_invalid: {
    status: 400,
    publicMessage: "Agent tool input does not match its schema",
  },

  // 401 Unauthorized
  unauthorized: { status: 401, publicMessage: "Unauthorized" },
  invalid_token: { status: 401, publicMessage: "Invalid authentication token" },
  revoked: { status: 401, publicMessage: "Authentication credential revoked" },
  org_mismatch: { status: 401, publicMessage: "Organization context mismatch" },
  invalid_session: { status: 401, publicMessage: "Invalid or expired session" },
  invalid_signature: { status: 401, publicMessage: "Invalid request signature" },
  token_expired: { status: 401, publicMessage: "Authentication token expired" },

  // 402 Payment Required / Entitlement
  entitlement_lapsed: {
    status: 402,
    publicMessage: "Organization entitlement has lapsed",
  },
  no_seat: {
    status: 402,
    publicMessage: "No active seat assigned for this organization",
  },

  // 403 Forbidden
  forbidden: { status: 403, publicMessage: "Forbidden" },
  scope_denied: {
    status: 403,
    publicMessage: "Insufficient scope for this operation",
  },
  insufficient_scope: {
    status: 403,
    publicMessage: "Insufficient scope for this operation",
  },
  origin_denied: { status: 403, publicMessage: "Request origin is not allowed" },
  admin_required: {
    status: 403,
    publicMessage: "Administrator privileges required",
  },
  actor_kind_denied: {
    status: 403,
    publicMessage: "Principal kind is not permitted for this route",
  },
  linear_input_forbidden: {
    status: 403,
    publicMessage: "Direct Linear input is forbidden on this endpoint",
  },
  agent_egress_host_denied: {
    status: 403,
    publicMessage: "Agent egress host is not on the allowlist",
  },

  // 404 Not Found
  not_found: { status: 404, publicMessage: "Not found" },
  route_not_found: { status: 404, publicMessage: "Route not found" },
  org_not_found: { status: 404, publicMessage: "Organization not found" },
  receipt_not_found: { status: 404, publicMessage: "Receipt not found" },
  cluster_not_found: { status: 404, publicMessage: "Cluster not found" },
  resource_not_found: { status: 404, publicMessage: "Resource not found" },

  // 405 Method Not Allowed
  method_not_allowed: { status: 405, publicMessage: "HTTP method not allowed" },

  // 409 Conflict
  conflict: { status: 409, publicMessage: "Conflict" },
  linear_disconnected: {
    status: 409,
    publicMessage: "Linear integration is not connected",
  },
  org_one_bound: { status: 409, publicMessage: "Organization is already bound" },
  already_bound: { status: 409, publicMessage: "Resource is already bound" },
  workspace_taken: {
    status: 409,
    publicMessage: "Workspace is already claimed by another organization",
  },
  idempotency_conflict: {
    status: 409,
    publicMessage: "Idempotency key conflict",
  },

  // 412 Precondition Failed
  precondition_failed: { status: 412, publicMessage: "Precondition failed" },

  // 413 Payload Too Large
  payload_too_large: {
    status: 413,
    publicMessage: "Request payload exceeds maximum size",
  },

  // 422 Unprocessable Entity
  unprocessable_entity: { status: 422, publicMessage: "Unprocessable entity" },
  invalid_spec: { status: 422, publicMessage: "Invalid specification" },
  unsupported_contract_version: {
    status: 422,
    publicMessage: "Unsupported contract version",
  },

  // 429 Too Many Requests
  rate_limited: { status: 429, publicMessage: "Rate limit exceeded" },
  quota_exceeded: { status: 429, publicMessage: "Quota exceeded" },

  // 500 Internal Server Error
  internal_error: { status: 500, publicMessage: "Internal server error" },
  secret_unconfigured: {
    status: 503,
    publicMessage: "Required secret is unconfigured",
  },
  secret_invalid: { status: 503, publicMessage: "Configured secret is invalid" },

  // 502 Bad Gateway
  bad_gateway: { status: 502, publicMessage: "Bad gateway" },
  upstream_error: { status: 502, publicMessage: "Upstream service error" },

  // 503 Service Unavailable
  service_unavailable: { status: 503, publicMessage: "Service unavailable" },
  internal_unavailable: {
    status: 503,
    publicMessage: "Internal service unavailable",
  },
  accounts_unavailable: {
    status: 503,
    publicMessage: "Accounts service unavailable",
  },
  events_unavailable: {
    status: 503,
    publicMessage: "Events service unavailable",
  },
  yak_unavailable: { status: 503, publicMessage: "Yak service unavailable" },
  graph_unavailable: { status: 503, publicMessage: "Graph service unavailable" },
  gateway_unavailable: {
    status: 503,
    publicMessage: "Gateway service unavailable",
  },
  linear_unavailable: {
    status: 503,
    publicMessage: "Linear service unavailable",
  },
  vendor_unconfigured: {
    status: 503,
    publicMessage: "Vendor integration is not configured",
  },
  agent_egress_unconfigured: {
    status: 503,
    publicMessage: "Agent model egress is not configured",
  },
} as const satisfies Record<
  string,
  { readonly status: HeraErrorStatus; readonly publicMessage: string }
>

export type HeraCatalogErrorCode = keyof typeof HERA_ERROR_CATALOG

export type HeraTemplateErrorCode =
  | `${string}_unconfigured`
  | `${string}_invalid_config`
  | `${string}_unavailable`

export type HeraErrorCode = HeraCatalogErrorCode | HeraTemplateErrorCode

export type HeraStatusForCode<C extends HeraWireErrorCode> =
  C extends HeraCatalogErrorCode
    ? (typeof HERA_ERROR_CATALOG)[C] extends { readonly status: infer S }
      ? S
      : never
    : 503

const DEFAULT_STATUS_MESSAGES: Readonly<Record<HeraErrorStatus, string>> = {
  400: "Bad request",
  401: "Unauthorized",
  402: "Payment required",
  403: "Forbidden",
  404: "Not found",
  405: "HTTP method not allowed",
  409: "Conflict",
  412: "Precondition failed",
  413: "Request payload exceeds maximum size",
  422: "Unprocessable entity",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway",
  503: "Service unavailable",
}

export function resolveCatalogPublicMessage(
  code: HeraWireErrorCode,
  status?: HeraErrorStatus
): string {
  if (Object.hasOwn(HERA_ERROR_CATALOG, code)) {
    return HERA_ERROR_CATALOG[code as HeraCatalogErrorCode].publicMessage
  }
  if (code.endsWith("_unconfigured")) {
    return "Required service configuration is unconfigured"
  }
  if (code.endsWith("_invalid_config")) {
    return "Service configuration is invalid"
  }
  if (code.endsWith("_unavailable")) {
    return "Upstream service unavailable"
  }
  return status !== undefined
    ? DEFAULT_STATUS_MESSAGES[status]
    : "Service unavailable"
}

export function resolveCatalogStatus(
  code: HeraWireErrorCode
): HeraErrorStatus {
  if (Object.hasOwn(HERA_ERROR_CATALOG, code)) {
    return HERA_ERROR_CATALOG[code as HeraCatalogErrorCode].status
  }
  return 503
}

export function isHeraErrorCode(u: unknown): u is HeraErrorCode {
  if (typeof u !== "string" || u.length === 0) {
    return false
  }
  if (Object.hasOwn(HERA_ERROR_CATALOG, u)) {
    return true
  }
  return (
    u.endsWith("_unconfigured") ||
    u.endsWith("_invalid_config") ||
    u.endsWith("_unavailable")
  )
}
