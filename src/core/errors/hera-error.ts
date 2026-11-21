import * as Data from "effect/Data"
import type * as Schema from "effect/Schema"
import type { HeraConfigError } from "../config/index.js"
import type { HeraSchemaError, HeraSchemaIssue } from "../schema/index.js"
import {
  type HeraErrorCode,
  type HeraErrorStatus,
  type HeraStatusForCode,
  resolveCatalogPublicMessage,
} from "./catalog.js"
import {
  defineHeraErrorClass,
  isAnyHeraError,
  isDefinedHeraError,
  isHeraErrorInstance,
  normalizeToHeraError,
  shapeFromConfigError,
  shapeFromSchemaError,
} from "./converters.js"
import type { HeraWireErrorCode } from "./domain-code.js"
import {
  buildProblemDetails,
  serializeProblemResponse,
} from "./problem-details.js"
import {
  type HeraDomainCodeSpecs,
  type HeraDomainCodeSpecsGuard,
  type HeraErrorCodeRegistry,
  makeHeraErrorCodeRegistry,
} from "./registry.js"
import { sanitizeErrorFields } from "./sanitizers.js"
import type {
  AnyHeraDefinedError,
  HeraDefinedErrorClass,
  HeraErrorDefineOptions,
  HeraErrorFactoryOptions,
  HeraErrorResponseOptions,
  HeraErrorShape,
  HeraProblemDetails,
} from "./types.js"

const BaseHeraError = Data.TaggedError("HeraError")<{
  readonly code: HeraWireErrorCode
  readonly httpStatus: HeraErrorStatus
  readonly publicMessage: string
  readonly message: string
  readonly requestId?: string | undefined
  readonly retryAfter?: number | undefined
  readonly fields?: Readonly<Record<string, unknown>> | undefined
  readonly issues?: ReadonlyArray<HeraSchemaIssue> | undefined
  readonly cause?: unknown
}>

function createStatusError(
  defaultCode: HeraErrorCode,
  httpStatus: HeraErrorStatus,
  publicMessage: string,
  options?: HeraErrorFactoryOptions
): HeraError {
  return new HeraError({
    code: options?.code ?? defaultCode,
    httpStatus,
    publicMessage: options?.publicMessage ?? publicMessage,
    ...(options?.requestId !== undefined
      ? { requestId: options.requestId }
      : {}),
    ...(options?.retryAfter !== undefined
      ? { retryAfter: options.retryAfter }
      : {}),
    ...(options?.fields !== undefined ? { fields: options.fields } : {}),
    ...(options?.issues !== undefined ? { issues: options.issues } : {}),
    ...(options?.cause !== undefined ? { cause: options.cause } : {}),
  })
}

/**
 * Closed-catalog yieldable error for Hera services.
 */
export class HeraError extends BaseHeraError {
  constructor(props: HeraErrorShape) {
    const resolvedPublic =
      props.publicMessage ??
      resolveCatalogPublicMessage(props.code, props.httpStatus)
    const sanitizedFields = sanitizeErrorFields(props.fields)
    super({
      code: props.code,
      httpStatus: props.httpStatus,
      publicMessage: resolvedPublic,
      message: props.message ?? resolvedPublic,
      ...(props.requestId !== undefined ? { requestId: props.requestId } : {}),
      ...(props.retryAfter !== undefined
        ? { retryAfter: props.retryAfter }
        : {}),
      ...(sanitizedFields !== undefined ? { fields: sanitizedFields } : {}),
      ...(props.issues !== undefined ? { issues: props.issues } : {}),
      ...(props.cause !== undefined ? { cause: props.cause } : {}),
    })
  }

  get status(): HeraErrorStatus {
    return this.httpStatus
  }

  toProblemDetails(options?: {
    readonly requestId?: string | undefined
  }): HeraProblemDetails {
    return buildProblemDetails(this, options)
  }

  toResponse(options?: HeraErrorResponseOptions): Response {
    return HeraError.toResponse(this, options)
  }

  override toJSON(): unknown {
    return this.toProblemDetails()
  }

  static is(u: unknown): u is HeraError {
    return isHeraErrorInstance(u)
  }

  static isDefinedError(u: unknown): u is AnyHeraDefinedError {
    return isDefinedHeraError(u)
  }

  static isAny(u: unknown): u is HeraError | AnyHeraDefinedError {
    return isAnyHeraError(u)
  }

  static define<
    const Tag extends string,
    const C extends HeraErrorCode,
    const S extends HeraErrorStatus = HeraStatusForCode<C>,
    const Fields extends Schema.Struct.Fields = {},
  >(
    tag: Tag,
    options: HeraErrorDefineOptions<C, S, Fields>
  ): HeraDefinedErrorClass<Tag, C, S, Fields> {
    return defineHeraErrorClass(
      tag,
      options,
      (shape) => new HeraError(shape),
      (err, opts) => HeraError.toResponse(err, opts)
    )
  }

  /**
   * Declares a service's domain error codes, each with its status. Throws at module
   * init on a non-snake_case key, a catalog/template collision or a status outside the union.
   */
  static codes<const Spec extends HeraDomainCodeSpecs>(
    service: string,
    spec: Spec & HeraDomainCodeSpecsGuard<Spec>
  ): HeraErrorCodeRegistry<Spec> {
    return makeHeraErrorCodeRegistry(
      service,
      spec as Spec,
      (shape) => new HeraError(shape),
      (err, opts) => HeraError.toResponse(err, opts)
    )
  }

  static toResponse(
    error: HeraError | AnyHeraDefinedError | unknown,
    options?: HeraErrorResponseOptions
  ): Response {
    const normalized = normalizeToHeraError(
      error,
      options,
      (shape) => new HeraError(shape)
    )
    const reqOpts =
      options?.requestId !== undefined
        ? { requestId: options.requestId }
        : undefined
    return serializeProblemResponse(
      normalized.toProblemDetails(reqOpts),
      options
    )
  }

  static badRequest(
    publicMessage = "Bad request",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("bad_request", 400, publicMessage, options)
  }

  static unauthorized(
    publicMessage = "Unauthorized",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("unauthorized", 401, publicMessage, options)
  }

  static paymentRequired(
    publicMessage = "Organization entitlement has lapsed",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("entitlement_lapsed", 402, publicMessage, options)
  }

  static forbidden(
    publicMessage = "Forbidden",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("forbidden", 403, publicMessage, options)
  }

  static notFound(
    publicMessage = "Not found",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("not_found", 404, publicMessage, options)
  }

  static methodNotAllowed(
    publicMessage = "HTTP method not allowed",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("method_not_allowed", 405, publicMessage, options)
  }

  static conflict(
    publicMessage = "Conflict",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("conflict", 409, publicMessage, options)
  }

  static preconditionFailed(
    publicMessage = "Precondition failed",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("precondition_failed", 412, publicMessage, options)
  }

  static payloadTooLarge(
    publicMessage = "Request payload exceeds maximum size",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("payload_too_large", 413, publicMessage, options)
  }

  static unprocessable(
    publicMessage = "Unprocessable entity",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError(
      "unprocessable_entity",
      422,
      publicMessage,
      options
    )
  }

  static rateLimited(
    publicMessage = "Rate limit exceeded",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("rate_limited", 429, publicMessage, options)
  }

  static internal(
    publicMessage = "Internal server error",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("internal_error", 500, publicMessage, options)
  }

  static badGateway(
    publicMessage = "Bad gateway",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("bad_gateway", 502, publicMessage, options)
  }

  static serviceUnavailable(
    publicMessage = "Service unavailable",
    options?: HeraErrorFactoryOptions
  ): HeraError {
    return createStatusError("service_unavailable", 503, publicMessage, options)
  }

  static fromSchemaError(
    err: HeraSchemaError,
    publicMessage = "Invalid request payload",
    code: HeraErrorCode = "invalid_request"
  ): HeraError {
    return new HeraError(shapeFromSchemaError(err, publicMessage, code))
  }

  static fromConfigError(err: HeraConfigError): HeraError {
    return new HeraError(shapeFromConfigError(err))
  }
}
