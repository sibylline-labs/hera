import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type {
  HeraActorKind,
  HeraAuthedCtx,
  HeraCtx,
  HeraCtxShape,
  HeraPublicCtx,
  HeraTenantCtx,
  HeraTenantCtxShape,
} from "../../core/context/index.js"
import type {
  AnyHeraDefinedError,
  HeraError,
} from "../../core/errors/index.js"
import type { HeraBodyFormat } from "../../core/http/index.js"
import type { HeraTelemetryHook, HeraTelemetrySource } from "../../core/telemetry/types.js"
import type {
  ActorId,
  OrgId,
  RequestId,
} from "../../core/schema/index.js"

/**
 * Structured, redacted log record emitted when an unhandled defect (`Cause.die`
 * or fiber interruption) is caught at an HTTP or RPC boundary.
 *
 * Never contains the raw defect `.message` or stack payload so sensitive tokens
 * or connection strings in thrown exceptions cannot leak.
 */
export interface HeraBoundaryDefectLog {
  readonly level: "error"
  readonly event: "hera.boundary.defect"
  readonly boundary: "http" | "rpc"
  readonly service: string
  readonly operation: string
  readonly request_id: string
  readonly org_id?: string | undefined
  readonly defect_kind: "die" | "interrupt" | "uncatalogued"
  readonly defect_name: string
}

/**
 * How a route reads its `body` (`HeraPublicRouteSpec.bodyFormat`): `"json"` parses JSON whatever
 * the `content-type`; `"json-or-form"` decodes an `application/x-www-form-urlencoded` body as a flat
 * string record (RFC 8628 §3.1, §3.4) and any other type as JSON.
 */
export type HeraRouteBodyFormat = HeraBodyFormat

/**
 * The body options a route spec carries, read by the boundary before the `body` schema runs.
 */
export interface HeraRouteBodyOptions {
  /**
   * Byte cap on the request body: a declared `content-length` over it, or a stream that passes it,
   * is `413 payload_too_large` before the `body` schema runs. A positive integer; unset reads the
   * whole body. Applies only with a `body` schema: a handler that gates before reading runs
   * `HeraHttp.readBody` itself.
   */
  readonly maxBodyBytes?: number | undefined
  /** Defaults to `"json"`. */
  readonly bodyFormat?: HeraRouteBodyFormat | undefined
}

export type SchemaDecoded<
  S extends Schema.Top | undefined,
  Fallback = undefined,
> = S extends Schema.Top ? S["Type"] : Fallback

/**
 * Decoded request context passed to a `Hera.publicRoute` handler.
 */
export interface HeraPublicRouteContext<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
> {
  readonly request: Request
  readonly requestId: RequestId
  readonly heraCtx: HeraCtxShape
  readonly params: SchemaDecoded<ParamsSchema, Readonly<Record<string, string>>>
  readonly query: SchemaDecoded<
    QuerySchema,
    Readonly<Record<string, unknown>>
  >
  readonly headers: SchemaDecoded<
    HeadersSchema,
    Readonly<Record<string, string>>
  >
  readonly body: SchemaDecoded<BodySchema, undefined>
}

/**
 * Decoded request + verified tenant context passed to a `Hera.authedRoute` handler.
 */
export interface HeraAuthedRouteContext<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
> extends HeraPublicRouteContext<
    ParamsSchema,
    QuerySchema,
    HeadersSchema,
    BodySchema
  > {
  readonly tenant: HeraTenantCtxShape
  readonly orgId: OrgId
  readonly actorId: Option.Option<ActorId>
  readonly actorKind: HeraActorKind | undefined
  readonly scopes: ReadonlyArray<string>
}

/**
 * Per-invocation options when executing a `Hera.publicRoute` or `Hera.authedRoute` at the Worker boundary.
 */
export interface HeraRouteInvokeOptions<R = never> {
  readonly params?: Readonly<Record<string, string>> | undefined
  readonly tenant?: HeraTenantCtxShape | null | undefined
  readonly heraCtx?: Partial<HeraCtxShape> | undefined
  readonly layer?: Layer.Layer<Exclude<R, HeraCtx | HeraTenantCtx>, never, never> | undefined
  readonly onDefect?: ((entry: HeraBoundaryDefectLog) => void) | undefined
  /** Traces and exports this request as one `HeraTelemetry` invocation (`{ telemetry, waitUntil: ctx.waitUntil.bind(ctx) }`). */
  readonly telemetry?: HeraTelemetryHook | undefined
  /** `"external"` (default) ignores the caller's `traceparent`; `"internal"` (a trusted binding) parents under it. */
  readonly trace?: HeraTelemetrySource | undefined
}

/**
 * Declarative specification for `Hera.publicRoute`.
 */
export interface HeraPublicRouteSpec<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraCtx,
> extends HeraRouteBodyOptions {
  readonly name?: string | undefined
  readonly method?: string | undefined
  readonly path?: string | undefined
  readonly status?: number | undefined
  readonly service?: string | undefined
  readonly params?: ParamsSchema
  readonly query?: QuerySchema
  readonly headers?: HeadersSchema
  readonly body?: BodySchema
  readonly onDefect?: ((entry: HeraBoundaryDefectLog) => void) | undefined
  readonly handler: (
    ctx: HeraPublicRouteContext<
      ParamsSchema,
      QuerySchema,
      HeadersSchema,
      BodySchema
    >
  ) => Effect.Effect<
    A,
    E,
    R
  >
}

/**
 * Auth resolution callback for `Hera.authedRoute`.
 */
export type HeraAuthResolver = (
  request: Request,
  ctx: HeraCtxShape
) =>
  | Effect.Effect<
      HeraTenantCtxShape | null | undefined,
      HeraError | AnyHeraDefinedError,
      never
    >
  | Promise<HeraTenantCtxShape | null | undefined>
  | HeraTenantCtxShape
  | null
  | undefined

/**
 * Declarative specification for `Hera.authedRoute`.
 */
export interface HeraAuthedRouteSpec<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraTenantCtx | HeraCtx,
> extends HeraRouteBodyOptions {
  readonly name?: string | undefined
  readonly method?: string | undefined
  readonly path?: string | undefined
  readonly status?: number | undefined
  readonly service?: string | undefined
  readonly scopes?: ReadonlyArray<string> | undefined
  readonly anyOfScopes?: ReadonlyArray<string> | undefined
  readonly actorKind?: HeraActorKind | ReadonlyArray<HeraActorKind> | undefined
  readonly resolveAuth?: HeraAuthResolver | undefined
  readonly params?: ParamsSchema
  readonly query?: QuerySchema
  readonly headers?: HeadersSchema
  readonly body?: BodySchema
  readonly onDefect?: ((entry: HeraBoundaryDefectLog) => void) | undefined
  /** Absent: the handler takes no authority ctx. See `HeraAuthorityRouteSpec`. */
  readonly authority?: undefined
  readonly handler: (
    ctx: HeraAuthedRouteContext<
      ParamsSchema,
      QuerySchema,
      HeadersSchema,
      BodySchema
    >
  ) => Effect.Effect<
    A,
    E,
    R
  >
}

/**
 * Executable HTTP boundary route returned by `Hera.publicRoute` and `Hera.authedRoute`.
 * Callable directly as `await route(request, options?)` or via `route.handle(request, options?)`.
 */
export interface HeraRoute<A = unknown, R = never> {
  (request: Request, options?: HeraRouteInvokeOptions<R>): Promise<Response>
  readonly kind: "public" | "authed"
  readonly operationName: string
  readonly method: string | undefined
  readonly path: string | undefined
  handle(
    request: Request,
    options?: HeraRouteInvokeOptions<R>
  ): Promise<Response>
  fetch(
    request: Request,
    options?: HeraRouteInvokeOptions<R>
  ): Promise<Response>
  toEffect(
    request: Request,
    options?: HeraRouteInvokeOptions<R>
  ): Effect.Effect<
    A,
    HeraError | AnyHeraDefinedError,
    Exclude<R, HeraCtx | HeraTenantCtx>
  >
}

export type HeraPublicRouteEnv = HeraPublicCtx
export type HeraAuthedRouteEnv = HeraPublicCtx | HeraAuthedCtx
export type HeraTenantRouteEnv = HeraPublicCtx | HeraTenantCtx
