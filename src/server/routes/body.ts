import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import {
  type HeraCtxShape,
  HeraTenantCtx,
  type HeraTenantCtxShape,
} from "../../core/context/index.js"
import {
  type AnyHeraDefinedError,
  HeraError,
  type HeraErrorCode,
} from "../../core/errors/index.js"
import {
  HeraSchema,
  type HeraSchemaError,
  type RequestId,
} from "../../core/schema/index.js"
import {
  extractHeadersRecord,
  extractPathParams,
  extractQueryRecord,
} from "./headers.js"
import { readRouteBody, refuseDeclaredOversize } from "./request-body.js"
import type {
  HeraAuthResolver,
  HeraRouteBodyOptions,
  HeraRouteInvokeOptions,
  SchemaDecoded,
} from "./types.js"

export function decodePart<S extends Schema.Top>(
  schema: S,
  input: unknown,
  code: HeraErrorCode,
  publicMessage: string,
  requestId: RequestId
): Effect.Effect<S["Type"], HeraError, never> {
  const decodeFn = HeraSchema.decodeUnknownEffect(
    schema as unknown as Schema.Codec<S["Type"], unknown, never, never>
  )
  return Effect.mapError(decodeFn(input), (schemaErr: HeraSchemaError) =>
    new HeraError({
      code,
      httpStatus: 400,
      publicMessage,
      requestId,
      issues: schemaErr.issues,
      cause: schemaErr,
    })
  )
}

export function parseJsonBody(
  request: Request,
  requestId: RequestId
): Effect.Effect<unknown, HeraError, never> {
  return readRouteBody(request, {}, requestId)
}

export function resolveCandidateTenant<R>(
  resolveAuth: HeraAuthResolver | undefined,
  request: Request,
  baseCtx: HeraCtxShape,
  invokeOptions?: HeraRouteInvokeOptions<R>
): Effect.Effect<
  HeraTenantCtxShape | null | undefined,
  HeraError | AnyHeraDefinedError,
  never
> {
  if (invokeOptions !== undefined && "tenant" in invokeOptions) {
    return Effect.succeed(invokeOptions.tenant)
  }
  if (resolveAuth !== undefined) {
    return Effect.gen(function* () {
      const out = resolveAuth(request, baseCtx)
      if (Effect.isEffect(out)) {
        return yield* out
      }
      if (out instanceof Promise) {
        return yield* Effect.tryPromise({
          try: () => out,
          catch: (err) =>
            HeraError.isAny(err)
              ? err
              : new HeraError({
                  code: "unauthorized",
                  httpStatus: 401,
                  publicMessage: "Unauthorized",
                  requestId: baseCtx.requestId,
                }),
        })
      }
      return out
    })
  }
  return Effect.map(Effect.serviceOption(HeraTenantCtx), (opt) =>
    Option.getOrUndefined(opt)
  )
}

export interface DecodedRouteParts<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
> {
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

export function decodeRouteRequestParts<
  ParamsSchema extends Schema.Top | undefined = undefined,
  QuerySchema extends Schema.Top | undefined = undefined,
  HeadersSchema extends Schema.Top | undefined = undefined,
  BodySchema extends Schema.Top | undefined = undefined,
>(
  request: Request,
  spec: HeraRouteBodyOptions & {
    readonly path?: string | undefined
    readonly params?: ParamsSchema
    readonly query?: QuerySchema
    readonly headers?: HeadersSchema
    readonly body?: BodySchema
  },
  requestId: RequestId,
  paramsOverride?: Readonly<Record<string, string>> | undefined
): Effect.Effect<
  DecodedRouteParts<ParamsSchema, QuerySchema, HeadersSchema, BodySchema>,
  HeraError,
  never
> {
  return Effect.gen(function* () {
    if (spec.body !== undefined && spec.maxBodyBytes !== undefined) {
      yield* refuseDeclaredOversize(request, spec.maxBodyBytes, requestId)
    }
    const url = new URL(request.url)
    const rawParams =
      paramsOverride ?? extractPathParams(spec.path, url.pathname)
    const decodedParams =
      spec.params !== undefined
        ? yield* decodePart(
            spec.params,
            rawParams,
            "invalid_path_params",
            "Invalid path parameters",
            requestId
          )
        : rawParams

    const rawQuery = extractQueryRecord(url)
    const decodedQuery =
      spec.query !== undefined
        ? yield* decodePart(
            spec.query,
            rawQuery,
            "invalid_query",
            "Invalid query parameters",
            requestId
          )
        : rawQuery

    const rawHeaders = extractHeadersRecord(request.headers)
    const decodedHeaders =
      spec.headers !== undefined
        ? yield* decodePart(
            spec.headers,
            rawHeaders,
            "invalid_headers",
            "Invalid request headers",
            requestId
          )
        : rawHeaders

    let decodedBody: unknown = undefined
    if (spec.body !== undefined) {
      const rawBody = yield* readRouteBody(request, spec, requestId)
      decodedBody = yield* decodePart(
        spec.body,
        rawBody,
        "invalid_request_body",
        "Invalid request body",
        requestId
      )
    }

    return {
      params: decodedParams as SchemaDecoded<
        ParamsSchema,
        Readonly<Record<string, string>>
      >,
      query: decodedQuery as SchemaDecoded<
        QuerySchema,
        Readonly<Record<string, unknown>>
      >,
      headers: decodedHeaders as SchemaDecoded<
        HeadersSchema,
        Readonly<Record<string, string>>
      >,
      body: decodedBody as SchemaDecoded<BodySchema, undefined>,
    }
  })
}
