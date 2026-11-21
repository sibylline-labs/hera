import type * as Cause from "effect/Cause"
import type * as Schema from "effect/Schema"
import type { HeraSchemaIssue } from "../schema/index.js"
import type {
  HeraCatalogErrorCode,
  HeraErrorCode,
  HeraErrorStatus,
  HeraStatusForCode,
  HeraTemplateErrorCode,
} from "./catalog.js"
import type { HeraWireErrorCode } from "./domain-code.js"
import type { HeraError } from "./hera-error.js"

export type {
  HeraCatalogErrorCode,
  HeraErrorCode,
  HeraErrorStatus,
  HeraStatusForCode,
  HeraTemplateErrorCode,
}

/**
 * URI prefix of every Hera problem `type`; the suffix is the error `code`.
 */
export const HERA_PROBLEM_TYPE_PREFIX = "urn:hera:error:"

/**
 * Media type of every Hera boundary error response.
 */
export const HERA_PROBLEM_CONTENT_TYPE =
  "application/problem+json; charset=utf-8"

/**
 * Public, value-stripped RFC 7807 Problem Details wire payload.
 * `type`/`title`/`status`/`detail` are the RFC members; `code` and the rest are extension members.
 * Never includes internal `cause` objects or raw rejected input values.
 */
export interface HeraProblemDetails {
  readonly type: `${typeof HERA_PROBLEM_TYPE_PREFIX}${HeraWireErrorCode}`
  readonly title: string
  readonly status: HeraErrorStatus
  readonly detail: string
  readonly code: HeraWireErrorCode
  readonly issues?: ReadonlyArray<HeraSchemaIssue>
  readonly request_id?: string
  readonly retry_after?: number
  readonly fields?: Readonly<Record<string, unknown>>
}

/**
 * Options for serializing a `HeraError` or defined error into an HTTP `Response`.
 */
export interface HeraErrorResponseOptions {
  readonly requestId?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
}

/**
 * Shape of a `HeraError` instance.
 */
export interface HeraErrorShape {
  readonly code: HeraWireErrorCode
  readonly httpStatus: HeraErrorStatus
  readonly publicMessage?: string | undefined
  readonly message?: string | undefined
  readonly requestId?: string | undefined
  readonly retryAfter?: number | undefined
  readonly fields?: Readonly<Record<string, unknown>> | undefined
  readonly issues?: ReadonlyArray<HeraSchemaIssue> | undefined
  readonly cause?: unknown
}

/**
 * Optional parameters for `HeraError` factory constructors.
 */
export interface HeraErrorFactoryOptions {
  readonly code?: HeraErrorCode | undefined
  readonly publicMessage?: string | undefined
  readonly requestId?: string | undefined
  readonly retryAfter?: number | undefined
  readonly fields?: Readonly<Record<string, unknown>> | undefined
  readonly issues?: ReadonlyArray<HeraSchemaIssue> | undefined
  readonly cause?: unknown
}

/**
 * Unique runtime brand identifying error classes created via `HeraError.define(...)`.
 */
export const HeraDefinedErrorTypeId: unique symbol = Symbol.for(
  "@sibylline-labs/hera/HeraDefinedError"
)

/**
 * Base interface shared by all error instances produced via `HeraError.define(...)`.
 */
export interface AnyHeraDefinedError extends Cause.YieldableError {
  readonly [HeraDefinedErrorTypeId]: typeof HeraDefinedErrorTypeId
  readonly _tag: string
  readonly code: HeraWireErrorCode
  readonly status: HeraErrorStatus
  readonly httpStatus: HeraErrorStatus
  readonly publicMessage: string
  readonly retryAfter?: number | undefined
  readonly requestId?: string | undefined
  readonly issues?: ReadonlyArray<HeraSchemaIssue> | undefined
  readonly definedFields: Readonly<Record<string, unknown>> | undefined
  toHeraError(options?: { readonly requestId?: string | undefined }): HeraError
  toProblemDetails(options?: {
    readonly requestId?: string | undefined
  }): HeraProblemDetails
  toResponse(options?: HeraErrorResponseOptions): Response
}

/**
 * Typed instance of a schema-backed error class created via `HeraError.define(tag, options)`.
 */
export type HeraDefinedErrorInstance<
  Tag extends string,
  C extends HeraWireErrorCode,
  S extends HeraErrorStatus,
  Fields extends Schema.Struct.Fields,
> = AnyHeraDefinedError & {
  readonly _tag: Tag
  readonly code: C
  readonly status: S
  readonly httpStatus: S
} & Readonly<Schema.Struct<Fields>["Type"]>

export type MakeInputForFields<Fields extends Schema.Struct.Fields> =
  Schema.Struct<Fields>["~type.make.in"]

/**
 * Constructor type returned by `HeraError.define(tag, options)`.
 */
export interface HeraDefinedErrorClass<
  Tag extends string,
  C extends HeraWireErrorCode,
  S extends HeraErrorStatus,
  Fields extends Schema.Struct.Fields = {},
> {
  readonly [HeraDefinedErrorTypeId]: typeof HeraDefinedErrorTypeId
  readonly _tag: Tag
  readonly identifier: Tag
  readonly code: C
  readonly status: S
  readonly httpStatus: S
  readonly publicMessage: string
  readonly fields: Fields
  new (
    ...args: {} extends MakeInputForFields<Fields>
      ? [props?: MakeInputForFields<Fields>]
      : [props: MakeInputForFields<Fields>]
  ): HeraDefinedErrorInstance<Tag, C, S, Fields>
  make(
    ...args: {} extends MakeInputForFields<Fields>
      ? [props?: MakeInputForFields<Fields>]
      : [props: MakeInputForFields<Fields>]
  ): HeraDefinedErrorInstance<Tag, C, S, Fields>
  is(u: unknown): u is HeraDefinedErrorInstance<Tag, C, S, Fields>
}

/**
 * Options for `HeraError.define(tag, options)`.
 */
export interface HeraErrorDefineOptions<
  C extends HeraWireErrorCode,
  S extends HeraErrorStatus = HeraStatusForCode<C>,
  Fields extends Schema.Struct.Fields = {},
> {
  readonly code: C
  readonly status?: S | undefined
  readonly publicMessage?: string | undefined
  readonly fields?: Fields | undefined
}
