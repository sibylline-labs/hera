import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import {
  HeraCtx,
  type HeraCtxShape,
  type HeraTenantCtx,
} from "../../core/context/index.js"
import type {
  AnyHeraDefinedError,
  HeraError,
} from "../../core/errors/index.js"
import { decodeRouteRequestParts } from "./body.js"
import { assertRouteBodyOptions } from "./request-body.js"
import { enforceMethod, resolveRequestId } from "./headers.js"
import { runRouteInvocation } from "./route-telemetry.js"
import {
  attachRouteProperties,
  exitToBoundaryResponse,
  type RouteBoundary,
} from "./response.js"
import type {
  HeraPublicRouteContext,
  HeraPublicRouteEnv,
  HeraPublicRouteSpec,
  HeraRoute,
  HeraRouteInvokeOptions,
} from "./types.js"

function buildPublicRouteEffect<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraCtx,
>(
  spec: HeraPublicRouteSpec<
    ParamsSchema,
    QuerySchema,
    HeadersSchema,
    BodySchema,
    A,
    E,
    R
  >,
  serviceName: string,
  operationName: string,
  request: Request,
  invokeOptions?: HeraRouteInvokeOptions<R>,
  boundary?: RouteBoundary
): Effect.Effect<
  A,
  HeraError | AnyHeraDefinedError,
  Exclude<R, HeraCtx | HeraTenantCtx>
> {
  const requestId =
    boundary?.requestId ??
    resolveRequestId(request, invokeOptions?.heraCtx?.requestId)
  const heraCtx: HeraCtxShape = {
    requestId,
    actorId: invokeOptions?.heraCtx?.actorId ?? Option.none(),
    orgId: invokeOptions?.heraCtx?.orgId ?? Option.none(),
    service: invokeOptions?.heraCtx?.service ?? serviceName,
  }

  const program = Effect.gen(function* () {
    yield* enforceMethod(spec.method, request.method, requestId)

    const decoded = yield* decodeRouteRequestParts(
      request,
      spec,
      requestId,
      invokeOptions?.params
    )

    const routeCtx: HeraPublicRouteContext<
      ParamsSchema,
      QuerySchema,
      HeadersSchema,
      BodySchema
    > = {
      request,
      requestId,
      heraCtx,
      params: decoded.params,
      query: decoded.query,
      headers: decoded.headers,
      body: decoded.body,
    }

    yield* Effect.annotateCurrentSpan({
      requestId: heraCtx.requestId,
      request_id: heraCtx.requestId,
      service: heraCtx.service,
      ...(Option.isSome(heraCtx.orgId)
        ? { orgId: heraCtx.orgId.value, org_id: heraCtx.orgId.value }
        : {}),
    })

    return yield* spec.handler(routeCtx)
  }).pipe(
    Effect.withSpan(operationName),
    Effect.provide(HeraCtx.layer(heraCtx))
  )

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
 * Builds a public HTTP route boundary, or acts as a
 * compile-time `HeraPublicCtx` capability gate when passed an `Effect` or handler function directly.
 *
 * Decodes `params`, `query`, `headers`, and JSON `body` via `HeraSchema` (`400` closed refusal
 * without echoing rejected input values), provides `HeraCtx` + tracing span, and converts
 * expected `HeraError`s via `HeraError.toResponse` while catching all defects (`Cause.die`)
 * into a closed `503 internal_unavailable` response.
 */
export function publicRoute<A, E = never>(
  effect: Effect.Effect<A, E, HeraPublicRouteEnv>
): Effect.Effect<A, E, HeraPublicRouteEnv>
export function publicRoute<Args extends ReadonlyArray<unknown>, A, E = never>(
  handler: (...args: Args) => Effect.Effect<A, E, HeraPublicRouteEnv>
): (...args: Args) => Effect.Effect<A, E, HeraPublicRouteEnv>
export function publicRoute<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraCtx,
>(
  spec: HeraPublicRouteSpec<
    ParamsSchema,
    QuerySchema,
    HeadersSchema,
    BodySchema,
    A,
    E,
    R
  >
): HeraRoute<A, R>
export function publicRoute<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraCtx,
>(
  specOrTarget:
    | HeraPublicRouteSpec<
        ParamsSchema,
        QuerySchema,
        HeadersSchema,
        BodySchema,
        A,
        E,
        R
      >
    | Effect.Effect<unknown, unknown, HeraPublicRouteEnv>
    | ((
        ...args: ReadonlyArray<never>
      ) => Effect.Effect<unknown, unknown, HeraPublicRouteEnv>)
): unknown {
  if (typeof specOrTarget === "function" || Effect.isEffect(specOrTarget)) {
    return specOrTarget
  }
  const spec = specOrTarget
  assertRouteBodyOptions(spec, "publicRoute")
  const serviceName = spec.service ?? "hera-http"
  const operationName =
    spec.name ?? `${spec.method?.toUpperCase() ?? "HTTP"} ${spec.path ?? "/"}`
  const successStatus = spec.status ?? 200

  const buildEffect = (
    request: Request,
    invokeOptions?: HeraRouteInvokeOptions<R>
  ) =>
    buildPublicRouteEffect(
      spec,
      serviceName,
      operationName,
      request,
      invokeOptions
    )

  const handle = async (
    request: Request,
    invokeOptions?: HeraRouteInvokeOptions<R>
  ): Promise<Response> => {
    const requestId = resolveRequestId(
      request,
      invokeOptions?.heraCtx?.requestId
    )
    const effect = buildPublicRouteEffect(
      spec,
      serviceName,
      operationName,
      request,
      invokeOptions,
      { requestId }
    ) as Effect.Effect<A, unknown, never>
    const callerOrgId = invokeOptions?.heraCtx?.orgId
    return runRouteInvocation(request, operationName, invokeOptions, effect, (exit) =>
      exitToBoundaryResponse(exit, {
        status: successStatus,
        requestId,
        orgId:
          callerOrgId !== undefined ? Option.getOrUndefined(callerOrgId) : undefined,
        service: invokeOptions?.heraCtx?.service ?? serviceName,
        operationName,
        onDefect: invokeOptions?.onDefect ?? spec.onDefect,
      })
    )
  }

  return attachRouteProperties(handle, {
    kind: "public",
    operationName,
    method: spec.method,
    path: spec.path,
    buildEffect,
  })
}
