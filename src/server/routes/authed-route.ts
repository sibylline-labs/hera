import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import {
  type HeraCtx,
  type HeraCtxShape,
  HeraTenantCtx,
  type HeraTenantCtxShape,
} from "../../core/context/index.js"
import type {
  AnyHeraDefinedError,
  HeraError,
} from "../../core/errors/index.js"
import {
  decodeRouteRequestParts,
  resolveCandidateTenant,
} from "./body.js"
import {
  enforceMethod,
  resolveRequestId,
  validateTenantAuth,
} from "./headers.js"
import { type HeraAuthorityRouteSpec, authorizeRoute } from "./authority.js"
import { assertRouteBodyOptions } from "./request-body.js"
import { runRouteInvocation } from "./route-telemetry.js"
import {
  attachRouteProperties,
  exitToBoundaryResponse,
  type RouteBoundary,
} from "./response.js"
import type {
  HeraAuthedRouteContext,
  HeraAuthedRouteEnv,
  HeraAuthedRouteSpec,
  HeraRoute,
  HeraRouteInvokeOptions,
  HeraTenantRouteEnv,
} from "./types.js"

export function tenantRoute<A, E = never>(
  effect: Effect.Effect<A, E, HeraTenantRouteEnv>
): Effect.Effect<A, E, HeraTenantRouteEnv>
export function tenantRoute<Args extends ReadonlyArray<unknown>, A, E = never>(
  handler: (...args: Args) => Effect.Effect<A, E, HeraTenantRouteEnv>
): (...args: Args) => Effect.Effect<A, E, HeraTenantRouteEnv>
export function tenantRoute(
  target:
    | Effect.Effect<unknown, unknown, HeraTenantRouteEnv>
    | ((...args: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, HeraTenantRouteEnv>)
): unknown {
  return target
}

type AnyAuthedRouteSpec<
  P extends Schema.Top | undefined,
  Q extends Schema.Top | undefined,
  H extends Schema.Top | undefined,
  B extends Schema.Top | undefined,
  A,
  E,
  R,
> =
  | HeraAuthedRouteSpec<P, Q, H, B, A, E, R>
  | HeraAuthorityRouteSpec<P, Q, H, B, A, E, R, string>

function buildAuthedRouteEffect<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraTenantCtx | HeraCtx,
>(
  spec: AnyAuthedRouteSpec<ParamsSchema, QuerySchema, HeadersSchema, BodySchema, A, E, R>,
  serviceName: string,
  operationName: string,
  request: Request,
  invokeOptions?: HeraRouteInvokeOptions<R>,
  boundary?: RouteBoundary
): Effect.Effect<A, HeraError | AnyHeraDefinedError, Exclude<R, HeraCtx | HeraTenantCtx>> {
  const requestId =
    boundary?.requestId ??
    resolveRequestId(
      request,
      invokeOptions?.tenant?.requestId ?? invokeOptions?.heraCtx?.requestId
    )
  const baseCtx: HeraCtxShape = {
    requestId,
    actorId: invokeOptions?.heraCtx?.actorId ?? Option.none(),
    orgId: invokeOptions?.heraCtx?.orgId ?? Option.none(),
    service:
      invokeOptions?.tenant?.service ??
      invokeOptions?.heraCtx?.service ??
      serviceName,
  }

  const program = Effect.gen(function* () {
    yield* enforceMethod(spec.method, request.method, requestId)

    const candidateTenant = yield* resolveCandidateTenant(
      spec.resolveAuth,
      request,
      baseCtx,
      invokeOptions
    )
    const { tenant, scopes } = yield* validateTenantAuth(
      candidateTenant,
      spec,
      requestId
    )

    const effectiveTenant: HeraTenantCtxShape = {
      ...tenant,
      requestId,
      service: tenant.service || baseCtx.service,
    }
    if (boundary !== undefined) {
      boundary.orgId = effectiveTenant.orgId
      boundary.service = effectiveTenant.service
    }
    const effectiveHeraCtx = HeraTenantCtx.toHeraCtx(effectiveTenant)

    const decoded = yield* decodeRouteRequestParts(
      request,
      spec,
      requestId,
      invokeOptions?.params
    )

    const routeCtx: HeraAuthedRouteContext<
      ParamsSchema,
      QuerySchema,
      HeadersSchema,
      BodySchema
    > = {
      request,
      requestId,
      heraCtx: effectiveHeraCtx,
      tenant: effectiveTenant,
      orgId: effectiveTenant.orgId,
      actorId: effectiveTenant.actorId,
      actorKind: effectiveTenant.actorKind,
      scopes,
      params: decoded.params,
      query: decoded.query,
      headers: decoded.headers,
      body: decoded.body,
    }

    yield* Effect.annotateCurrentSpan({
      requestId: effectiveTenant.requestId,
      request_id: effectiveTenant.requestId,
      orgId: effectiveTenant.orgId,
      org_id: effectiveTenant.orgId,
      service: effectiveTenant.service,
      ...(Option.isSome(effectiveTenant.actorId)
        ? {
            actorId: effectiveTenant.actorId.value,
            actor_id: effectiveTenant.actorId.value,
          }
        : {}),
    })

    const handled =
      spec.authority === undefined
        ? spec.handler(routeCtx)
        : Effect.flatMap(
            authorizeRoute(operationName, spec.authority, routeCtx),
            (authority) => spec.handler(routeCtx, authority)
          )
    return yield* Effect.provide(handled, HeraTenantCtx.layer(effectiveTenant))
  }).pipe(Effect.withSpan(operationName))

  const withUserLayer =
    invokeOptions?.layer !== undefined
      ? Effect.provide(program, invokeOptions.layer)
      : program

  return withUserLayer as Effect.Effect<
    A,
    HeraError | AnyHeraDefinedError,
    Exclude<R, HeraCtx | HeraTenantCtx>
  >
}

/**
 * Builds an authenticated, tenant-scoped HTTP route boundary,
 * or acts as a compile-time `HeraAuthedCtx` capability gate when passed an `Effect` or handler function directly.
 */
export function authedRoute<A, E = never>(
  effect: Effect.Effect<A, E, HeraAuthedRouteEnv>
): Effect.Effect<A, E, HeraAuthedRouteEnv>
export function authedRoute<Args extends ReadonlyArray<unknown>, A, E = never>(
  handler: (...args: Args) => Effect.Effect<A, E, HeraAuthedRouteEnv>
): (...args: Args) => Effect.Effect<A, E, HeraAuthedRouteEnv>
export function authedRoute<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraTenantCtx | HeraCtx,
>(
  spec: HeraAuthedRouteSpec<ParamsSchema, QuerySchema, HeadersSchema, BodySchema, A, E, R>
): HeraRoute<A, R>
export function authedRoute<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraTenantCtx | HeraCtx,
  V extends string = string,
>(
  spec: HeraAuthorityRouteSpec<ParamsSchema, QuerySchema, HeadersSchema, BodySchema, A, E, R, V>
): HeraRoute<A, R>
export function authedRoute<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraTenantCtx | HeraCtx,
>(
  specOrTarget:
    | AnyAuthedRouteSpec<ParamsSchema, QuerySchema, HeadersSchema, BodySchema, A, E, R>
    | Effect.Effect<unknown, unknown, HeraAuthedRouteEnv>
    | ((...args: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, HeraAuthedRouteEnv>)
): unknown {
  if (typeof specOrTarget === "function" || Effect.isEffect(specOrTarget)) {
    return specOrTarget
  }
  const spec = specOrTarget
  assertRouteBodyOptions(spec, "authedRoute")
  const serviceName = spec.service ?? "hera-http"
  const operationName =
    spec.name ?? `${spec.method?.toUpperCase() ?? "HTTP"} ${spec.path ?? "/"}`
  const successStatus = spec.status ?? 200

  const buildEffect = (
    request: Request,
    invokeOptions?: HeraRouteInvokeOptions<R>
  ) =>
    buildAuthedRouteEffect(spec, serviceName, operationName, request, invokeOptions)

  const handle = async (
    request: Request,
    invokeOptions?: HeraRouteInvokeOptions<R>
  ): Promise<Response> => {
    const requestId = resolveRequestId(
      request,
      invokeOptions?.tenant?.requestId ?? invokeOptions?.heraCtx?.requestId
    )
    const boundary: RouteBoundary = { requestId }
    const effect = buildAuthedRouteEffect(
      spec,
      serviceName,
      operationName,
      request,
      invokeOptions,
      boundary
    ) as Effect.Effect<A, unknown, never>
    return runRouteInvocation(request, operationName, invokeOptions, effect, (exit) =>
      exitToBoundaryResponse(exit, {
        status: successStatus,
        requestId,
        orgId: boundary.orgId ?? invokeOptions?.tenant?.orgId,
        service:
          boundary.service ??
          invokeOptions?.tenant?.service ??
          invokeOptions?.heraCtx?.service ??
          serviceName,
        operationName,
        onDefect: invokeOptions?.onDefect ?? spec.onDefect,
      })
    )
  }

  return attachRouteProperties(handle, {
    kind: "authed",
    operationName,
    method: spec.method,
    path: spec.path,
    buildEffect,
  })
}
