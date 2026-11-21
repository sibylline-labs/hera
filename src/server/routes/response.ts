import * as Cause from "effect/Cause"
import type * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import { HeraConfig } from "../../core/config/index.js"
import type { HeraCtx, HeraTenantCtx } from "../../core/context/index.js"
import {
  type AnyHeraDefinedError,
  HeraError,
} from "../../core/errors/index.js"
import {
  HeraSchema,
  type OrgId,
  type RequestId,
} from "../../core/schema/index.js"
import type {
  HeraBoundaryDefectLog,
  HeraRoute,
  HeraRouteInvokeOptions,
} from "./types.js"
import { isUpgradeResponse } from "./upgrade-response.js"

/**
 * Extracts only the structural class/tag identifier of a defect, never its `.message`.
 */
export function extractSafeDefectName(defect: unknown): string {
  if (typeof defect === "object" && defect !== null) {
    if (
      "_tag" in defect &&
      typeof (defect as { readonly _tag?: unknown })._tag === "string"
    ) {
      return (defect as { readonly _tag: string })._tag
    }
    const ctorName = (
      defect as { readonly constructor?: { readonly name?: unknown } }
    ).constructor?.name
    if (typeof ctorName === "string" && ctorName.length > 0) {
      return ctorName
    }
    return "ObjectDefect"
  }
  if (typeof defect === "string") {
    return "StringDefect"
  }
  return typeof defect
}

export function serializeSuccessResponse(
  value: unknown,
  status: number,
  requestId: RequestId
): Response {
  if (value instanceof Response) {
    // An upgrade carries a socket that a rebuilt `Response` would drop, and its headers are immutable.
    if (isUpgradeResponse(value)) {
      return value
    }
    const headers = new Headers(value.headers)
    if (!headers.has("cache-control")) {
      headers.set("cache-control", "no-store")
    }
    if (!headers.has("x-request-id")) {
      headers.set("x-request-id", requestId)
    }
    return new Response(value.body, {
      status: value.status,
      statusText: value.statusText,
      headers,
    })
  }

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestId,
  })

  if (status === 204 || value === undefined) {
    return new Response(
      status === 204
        ? null
        : JSON.stringify({ ok: true, request_id: requestId }),
      {
        status,
        headers,
      }
    )
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const payload = {
      ok: typeof record.ok === "boolean" ? record.ok : true,
      ...record,
      data: value,
      request_id:
        typeof record.request_id === "string" ? record.request_id : requestId,
    }
    return new Response(JSON.stringify(payload), {
      status,
      headers,
    })
  }

  return new Response(
    JSON.stringify({
      ok: true,
      data: value,
      request_id: requestId,
    }),
    {
      status,
      headers,
    }
  )
}

/**
 * What a route's `handle` and its effect share for one request: the one resolved request id, and
 * the ctx the effect accepted (tenant `orgId`, `service`), so the boundary log names what the
 * handler saw rather than re-deriving it from `invokeOptions`.
 */
export interface RouteBoundary {
  readonly requestId: RequestId
  orgId?: OrgId | undefined
  service?: string | undefined
}

export function exitToBoundaryResponse<A>(
  exit: Exit.Exit<A, unknown>,
  options: {
    readonly status: number
    readonly requestId: RequestId
    readonly orgId?: OrgId | undefined
    readonly service: string
    readonly operationName: string
    readonly onDefect?: ((entry: HeraBoundaryDefectLog) => void) | undefined
  }
): Response {
  if (Exit.isSuccess(exit)) {
    return serializeSuccessResponse(
      exit.value,
      options.status,
      options.requestId
    )
  }

  const cause = exit.cause
  const hasDefectOrInterrupt =
    Cause.hasDies(cause) || Cause.hasInterrupts(cause)

  if (!hasDefectOrInterrupt) {
    const failOpt = Cause.findErrorOption(cause)
    if (Option.isSome(failOpt)) {
      const err = failOpt.value
      if (HeraError.isAny(err)) {
        return HeraError.toResponse(err, { requestId: options.requestId })
      }
      if (HeraSchema.isHeraSchemaError(err)) {
        return HeraError.fromSchemaError(err).toResponse({
          requestId: options.requestId,
        })
      }
      if (err instanceof HeraConfig.HeraConfigError) {
        return HeraError.fromConfigError(err).toResponse({
          requestId: options.requestId,
        })
      }
    }
  }

  // Defect, interrupt, or uncatalogued error: log redacted internal event and return closed 503.
  const dieReasons = cause.reasons.filter(Cause.isDieReason)
  const firstDefect =
    dieReasons.length > 0
      ? dieReasons[0]?.defect
      : Option.getOrUndefined(Cause.findErrorOption(cause))

  const defectLog: HeraBoundaryDefectLog = {
    level: "error",
    event: "hera.boundary.defect",
    boundary: "http",
    service: options.service,
    operation: options.operationName,
    request_id: options.requestId,
    ...(options.orgId !== undefined ? { org_id: options.orgId } : {}),
    defect_kind: Cause.hasInterrupts(cause)
      ? "interrupt"
      : Cause.hasDies(cause)
        ? "die"
        : "uncatalogued",
    defect_name: extractSafeDefectName(firstDefect),
  }

  options.onDefect?.(defectLog)

  return new HeraError({
    code: "internal_unavailable",
    httpStatus: 503,
    publicMessage: "Internal service unavailable",
    requestId: options.requestId,
  }).toResponse({ requestId: options.requestId })
}

export function attachRouteProperties<A, R>(
  handle: (
    request: Request,
    options?: HeraRouteInvokeOptions<R>
  ) => Promise<Response>,
  meta: {
    readonly kind: "public" | "authed"
    readonly operationName: string
    readonly method: string | undefined
    readonly path: string | undefined
    readonly buildEffect: (
      request: Request,
      options?: HeraRouteInvokeOptions<R>
    ) => Effect.Effect<
      A,
      HeraError | AnyHeraDefinedError,
      Exclude<R, HeraCtx | HeraTenantCtx>
    >
  }
): HeraRoute<A, R> {
  const routeFn = ((
    request: Request,
    invokeOptions?: HeraRouteInvokeOptions<R>
  ) => handle(request, invokeOptions)) as HeraRoute<A, R>

  Object.defineProperties(routeFn, {
    kind: { value: meta.kind, enumerable: true },
    operationName: { value: meta.operationName, enumerable: true },
    method: { value: meta.method, enumerable: true },
    path: { value: meta.path, enumerable: true },
    handle: { value: handle, enumerable: true },
    fetch: { value: handle, enumerable: true },
    toEffect: { value: meta.buildEffect, enumerable: true },
  })

  return routeFn
}
