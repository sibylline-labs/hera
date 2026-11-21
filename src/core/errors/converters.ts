import type * as Cause from "effect/Cause"
import * as Schema from "effect/Schema"
import type { HeraConfigError } from "../config/index.js"
import type { HeraSchemaError } from "../schema/index.js"
import {
  type HeraErrorCode,
  type HeraErrorStatus,
  type HeraStatusForCode,
  resolveCatalogPublicMessage,
  resolveCatalogStatus,
} from "./catalog.js"
import type { HeraWireErrorCode } from "./domain-code.js"
import type { HeraError } from "./hera-error.js"
import { sanitizeErrorFields } from "./sanitizers.js"
import {
  type AnyHeraDefinedError,
  type HeraDefinedErrorClass,
  type HeraDefinedErrorInstance,
  HeraDefinedErrorTypeId,
  type HeraErrorDefineOptions,
  type HeraErrorResponseOptions,
  type HeraErrorShape,
  type HeraProblemDetails,
} from "./types.js"

export function isHeraErrorInstance(u: unknown): u is HeraError {
  return (
    typeof u === "object" &&
    u !== null &&
    "_tag" in u &&
    (u as { readonly _tag?: unknown })._tag === "HeraError"
  )
}

export function isDefinedHeraError(u: unknown): u is AnyHeraDefinedError {
  return (
    typeof u === "object" &&
    u !== null &&
    HeraDefinedErrorTypeId in u &&
    (u as Record<symbol, unknown>)[HeraDefinedErrorTypeId] ===
      HeraDefinedErrorTypeId
  )
}

export function isAnyHeraError(
  u: unknown
): u is HeraError | AnyHeraDefinedError {
  return isHeraErrorInstance(u) || isDefinedHeraError(u)
}

export function shapeFromSchemaError(
  err: HeraSchemaError,
  publicMessage = "Invalid request payload",
  code: HeraErrorCode = "invalid_request"
): HeraErrorShape {
  return {
    code,
    httpStatus: 400,
    publicMessage,
    issues: err.issues,
    cause: err,
  }
}

export function shapeFromConfigError(err: HeraConfigError): HeraErrorShape {
  return {
    code: err.errorCode as HeraErrorCode,
    httpStatus: 503,
    publicMessage: err.message,
    ...(err.issues.length > 0 ? { issues: err.issues } : {}),
    cause: err,
  }
}

export function normalizeToHeraError(
  error: HeraError | AnyHeraDefinedError | unknown,
  options: HeraErrorResponseOptions | undefined,
  makeHeraError: (shape: HeraErrorShape) => HeraError
): HeraError {
  const reqOpts =
    options?.requestId !== undefined
      ? { requestId: options.requestId }
      : undefined
  if (isHeraErrorInstance(error)) {
    return error
  }
  if (isDefinedHeraError(error)) {
    return error.toHeraError(reqOpts)
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "HeraConfigError"
  ) {
    return makeHeraError(shapeFromConfigError(error as HeraConfigError))
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "HeraSchemaError"
  ) {
    return makeHeraError(shapeFromSchemaError(error as HeraSchemaError))
  }
  return makeHeraError({
    code: "internal_unavailable",
    httpStatus: 503,
    publicMessage: resolveCatalogPublicMessage("internal_unavailable", 503),
    ...(reqOpts ?? {}),
  })
}

export function defineHeraErrorClass<
  const Tag extends string,
  const C extends HeraWireErrorCode,
  const S extends HeraErrorStatus = HeraStatusForCode<C>,
  const Fields extends Schema.Struct.Fields = {},
>(
  tag: Tag,
  options: HeraErrorDefineOptions<C, S, Fields>,
  makeHeraError: (shape: HeraErrorShape) => HeraError,
  renderResponse: (
    error: AnyHeraDefinedError,
    opts?: HeraErrorResponseOptions
  ) => Response
): HeraDefinedErrorClass<Tag, C, S, Fields> {
  const resolvedStatus = (options.status ??
    resolveCatalogStatus(options.code)) as S
  const resolvedPublicMessage =
    options.publicMessage ??
    resolveCatalogPublicMessage(options.code, resolvedStatus)
  const fieldSchemas = (options.fields ?? {}) as Fields
  const fieldKeys = Object.keys(fieldSchemas)

  const TaggedBase = Schema.TaggedError<any>()(
    tag,
    fieldSchemas
  ) as unknown as new (
    props: unknown,
    makeOptions?: Schema.MakeOptions
  ) => Cause.YieldableError & Record<string, unknown>

  class DefinedHeraError extends TaggedBase {
    static readonly [HeraDefinedErrorTypeId] = HeraDefinedErrorTypeId
    static readonly _tag = tag
    static readonly code = options.code
    static readonly status = resolvedStatus
    static readonly httpStatus = resolvedStatus
    static readonly publicMessage = resolvedPublicMessage

    static is(u: unknown): u is HeraDefinedErrorInstance<Tag, C, S, Fields> {
      return (
        isDefinedHeraError(u) && u._tag === tag && u.code === options.code
      )
    }

    get [HeraDefinedErrorTypeId](): typeof HeraDefinedErrorTypeId {
      return HeraDefinedErrorTypeId
    }

    get code(): C {
      return options.code
    }

    get status(): S {
      return resolvedStatus
    }

    get httpStatus(): S {
      return resolvedStatus
    }

    get publicMessage(): string {
      return resolvedPublicMessage
    }

    override get message(): string {
      return resolvedPublicMessage
    }

    get definedFields(): Readonly<Record<string, unknown>> | undefined {
      if (fieldKeys.length === 0) {
        return undefined
      }
      const raw: Record<string, unknown> = {}
      const selfRecord = this as unknown as Record<string, unknown>
      for (const key of fieldKeys) {
        if (key in selfRecord && selfRecord[key] !== undefined) {
          raw[key] = selfRecord[key]
        }
      }
      return sanitizeErrorFields(raw)
    }

    toHeraError(opts?: { readonly requestId?: string | undefined }): HeraError {
      const selfRecord = this as unknown as Record<string, unknown>
      const retryAfter =
        typeof selfRecord.retryAfter === "number"
          ? selfRecord.retryAfter
          : typeof selfRecord.retry_after === "number"
            ? selfRecord.retry_after
            : undefined
      const reqId =
        opts?.requestId ??
        (typeof selfRecord.requestId === "string"
          ? selfRecord.requestId
          : undefined)
      const definedFields = this.definedFields
      return makeHeraError({
        code: options.code,
        httpStatus: resolvedStatus,
        publicMessage: resolvedPublicMessage,
        ...(reqId !== undefined ? { requestId: reqId } : {}),
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        ...(definedFields !== undefined ? { fields: definedFields } : {}),
      })
    }

    toProblemDetails(opts?: {
      readonly requestId?: string | undefined
    }): HeraProblemDetails {
      return this.toHeraError(opts).toProblemDetails(opts)
    }

    toResponse(opts?: HeraErrorResponseOptions): Response {
      return renderResponse(this as unknown as AnyHeraDefinedError, opts)
    }

    override toJSON(): unknown {
      return this.toProblemDetails()
    }
  }

  return DefinedHeraError as unknown as HeraDefinedErrorClass<
    Tag,
    C,
    S,
    Fields
  >
}
