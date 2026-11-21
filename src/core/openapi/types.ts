/**
 * Input and output shapes of `HeraOpenApi.document`.
 */

import type * as JsonSchema from "effect/JsonSchema"
import type * as Schema from "effect/Schema"

export type HeraOpenApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** A security requirement: scheme name → required scopes (`[]` for bearer). */
export type HeraOpenApiSecurityRequirement = Readonly<Record<string, ReadonlyArray<string>>>

export interface HeraOpenApiResponse {
  readonly description: string
  /** The body schema; omit for a response with no body. */
  readonly schema?: Schema.Top | undefined
  /** Defaults to `application/json`. */
  readonly contentType?: string | undefined
}

/**
 * One operation. `params` and `query` are `Schema.Struct`s: each field becomes an `in: path`
 * (always required) or `in: query` (required unless the field is optional) parameter. `body`
 * becomes a required `application/json` request body.
 */
export interface HeraOpenApiOperation {
  readonly operationId: string
  readonly method: HeraOpenApiMethod
  /** OpenAPI form, e.g. `/v1/evidence/{fragment_id}`. */
  readonly path: string
  readonly summary?: string | undefined
  readonly security?: ReadonlyArray<HeraOpenApiSecurityRequirement> | undefined
  readonly params?: Schema.Top | undefined
  readonly query?: Schema.Top | undefined
  readonly body?: Schema.Top | undefined
  /** Keyed by status code (`"200"`) or `"default"`. */
  readonly responses: Readonly<Record<string, HeraOpenApiResponse>>
}

export interface HeraOpenApiSpec {
  readonly info: {
    readonly title: string
    readonly version: string
    readonly description?: string | undefined
  }
  readonly servers?: ReadonlyArray<{ readonly url: string }> | undefined
  readonly securitySchemes?: Readonly<Record<string, unknown>> | undefined
  readonly operations: ReadonlyArray<HeraOpenApiOperation>
}

export interface HeraOpenApiParameterObject {
  readonly name: string
  readonly in: "path" | "query"
  readonly required: boolean
  readonly schema: JsonSchema.JsonSchema
}

export interface HeraOpenApiMediaTypes {
  readonly [contentType: string]: { readonly schema: JsonSchema.JsonSchema }
}

export interface HeraOpenApiOperationObject {
  readonly operationId: string
  readonly summary?: string
  readonly parameters?: ReadonlyArray<HeraOpenApiParameterObject>
  readonly requestBody?: { readonly required: true; readonly content: HeraOpenApiMediaTypes }
  readonly responses: Readonly<
    Record<string, { readonly description: string; readonly content?: HeraOpenApiMediaTypes }>
  >
  readonly security?: ReadonlyArray<HeraOpenApiSecurityRequirement>
}

/** An OpenAPI 3.1.0 document; every `$ref` points into `components.schemas`. */
export interface HeraOpenApiDocument {
  readonly openapi: "3.1.0"
  readonly jsonSchemaDialect: string
  readonly info: HeraOpenApiSpec["info"]
  readonly servers?: ReadonlyArray<{ readonly url: string }>
  readonly paths: Readonly<
    Record<string, Readonly<Partial<Record<Lowercase<HeraOpenApiMethod>, HeraOpenApiOperationObject>>>>
  >
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchema.JsonSchema>>
    readonly securitySchemes?: Readonly<Record<string, unknown>>
  }
}
