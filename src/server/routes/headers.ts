import * as Effect from "effect/Effect"
import type {
  HeraActorKind,
  HeraTenantCtxShape,
} from "../../core/context/index.js"
import { HeraError } from "../../core/errors/index.js"
import { mintRequestId } from "../../core/context/request-id.js"
import { OrgId, RequestId } from "../../core/schema/index.js"
import { pathParamName } from "./path-match.js"


/**
 * Normalizes a scope collection by splitting any whitespace- or comma-delimited
 * entries across ALL scope instances.
 */
export function normalizeScopes(
  scopes: ReadonlyArray<string> | string | undefined | null
): ReadonlyArray<string> {
  if (scopes === undefined || scopes === null) {
    return []
  }
  const list = typeof scopes === "string" ? [scopes] : scopes
  const out: Array<string> = []
  for (const entry of list) {
    if (typeof entry !== "string") {
      continue
    }
    for (const token of entry.split(/[\s,]+/)) {
      const trimmed = token.trim()
      if (trimmed.length > 0 && !out.includes(trimmed)) {
        out.push(trimmed)
      }
    }
  }
  return out
}

/**
 * Checks whether `grantedScopes` (scanning all entries) satisfies `requiredScope`.
 * Supports exact matches, `"*"`, and namespace wildcards (`"<prefix>:*"`).
 */
export function hasGrantedScope(
  grantedScopes: ReadonlyArray<string>,
  requiredScope: string
): boolean {
  for (const granted of grantedScopes) {
    if (granted === "*" || granted === requiredScope) {
      return true
    }
    if (granted.endsWith(":*")) {
      const prefix = granted.slice(0, -1) // keeps trailing ':'
      if (requiredScope.startsWith(prefix)) {
        return true
      }
    }
  }
  return false
}

/**
 * Extracts `:param` / `{param}` segments from a URL pathname given a route pattern like
 * `"/v1/orgs/:orgId/keys/{keyId}"`.
 */
export function extractPathParams(
  pattern: string | undefined,
  pathname: string
): Record<string, string> {
  if (pattern === undefined) {
    return {}
  }
  const patternParts = pattern.split("/").filter(Boolean)
  const pathParts = pathname.split("/").filter(Boolean)
  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i]
    const actual = pathParts[i]
    const key = part === undefined ? undefined : pathParamName(part)
    if (key !== undefined && actual !== undefined) {
      if (key.length > 0) {
        try {
          params[key] = decodeURIComponent(actual)
        } catch {
          params[key] = actual
        }
      }
    }
  }
  return params
}

export function extractQueryRecord(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of url.searchParams.keys()) {
    const all = url.searchParams.getAll(key)
    if (all.length === 1) {
      out[key] = all[0]
    } else if (all.length > 1) {
      out[key] = all
    }
  }
  return out
}

export function extractHeadersRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

export function resolveRequestId(
  request: Request,
  override?: RequestId | string
): RequestId {
  if (override !== undefined && RequestId.is(override)) {
    return override
  }
  const headerCandidate =
    request.headers.get("x-request-id") ??
    request.headers.get("cf-ray") ??
    undefined
  if (headerCandidate !== undefined && RequestId.is(headerCandidate)) {
    return headerCandidate
  }
  return mintRequestId()
}

export function enforceMethod(
  expectedMethod: string | undefined,
  actualMethod: string,
  requestId: RequestId
): Effect.Effect<void, HeraError, never> {
  if (
    expectedMethod !== undefined &&
    expectedMethod.toUpperCase() !== actualMethod.toUpperCase()
  ) {
    return Effect.fail(
      new HeraError({
        code: "method_not_allowed",
        httpStatus: 405,
        publicMessage: "HTTP method not allowed",
        requestId,
      })
    )
  }
  return Effect.void
}

export function validateTenantAuth(
  tenant: HeraTenantCtxShape | null | undefined,
  spec: {
    readonly scopes?: ReadonlyArray<string> | undefined
    readonly anyOfScopes?: ReadonlyArray<string> | undefined
    readonly actorKind?: HeraActorKind | ReadonlyArray<HeraActorKind> | undefined
  },
  requestId: RequestId
): Effect.Effect<
  {
    readonly tenant: HeraTenantCtxShape
    readonly scopes: ReadonlyArray<string>
  },
  HeraError,
  never
> {
  if (
    tenant === undefined ||
    tenant === null ||
    !OrgId.is(tenant.orgId)
  ) {
    return Effect.fail(
      new HeraError({
        code: "unauthorized",
        httpStatus: 401,
        publicMessage: "Unauthorized",
        requestId,
      })
    )
  }

  if (spec.actorKind !== undefined) {
    const allowedKinds: ReadonlyArray<HeraActorKind> =
      typeof spec.actorKind === "string" ? [spec.actorKind] : spec.actorKind
    const actualKind = tenant.actorKind
    const isAdminSatisfyingUser =
      actualKind === "admin" && allowedKinds.includes("user")
    const permitted =
      actualKind !== undefined &&
      (allowedKinds.includes(actualKind) || isAdminSatisfyingUser)
    if (!permitted) {
      const requiresOnlyAdmin =
        allowedKinds.length === 1 && allowedKinds[0] === "admin"
      return Effect.fail(
        new HeraError({
          code: requiresOnlyAdmin ? "admin_required" : "actor_kind_denied",
          httpStatus: 403,
          publicMessage: requiresOnlyAdmin
            ? "Administrator privileges required"
            : "Principal kind is not permitted for this route",
          requestId,
        })
      )
    }
  }

  const normalizedScopes = normalizeScopes(tenant.scopes)

  if (spec.scopes !== undefined && spec.scopes.length > 0) {
    for (const required of spec.scopes) {
      if (!hasGrantedScope(normalizedScopes, required)) {
        return Effect.fail(
          new HeraError({
            code: "scope_denied",
            httpStatus: 403,
            publicMessage: "Insufficient scope for this operation",
            requestId,
            fields: {
              required_scope: required,
            },
          })
        )
      }
    }
  }

  if (spec.anyOfScopes !== undefined && spec.anyOfScopes.length > 0) {
    const matched = spec.anyOfScopes.some((reqScope) =>
      hasGrantedScope(normalizedScopes, reqScope)
    )
    if (!matched) {
      return Effect.fail(
        new HeraError({
          code: "scope_denied",
          httpStatus: 403,
          publicMessage: "Insufficient scope for this operation",
          requestId,
        })
      )
    }
  }

  return Effect.succeed({
    tenant: {
      ...tenant,
      scopes: normalizedScopes,
    },
    scopes: normalizedScopes,
  })
}
