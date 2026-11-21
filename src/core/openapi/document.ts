/**
 * `HeraOpenApi.document`: an OpenAPI 3.1.0 document from a table of operations whose request and
 * response shapes are Effect schemas. Pure and deterministic: the same spec yields a
 * byte-identical `JSON.stringify`.
 */

import * as JsonSchema from "effect/JsonSchema"
import type * as Schema from "effect/Schema"
import { HeraOpenApiComponents } from "./components.js"
import type {
  HeraOpenApiDocument,
  HeraOpenApiMediaTypes,
  HeraOpenApiMethod,
  HeraOpenApiOperation,
  HeraOpenApiOperationObject,
  HeraOpenApiParameterObject,
  HeraOpenApiSpec,
} from "./types.js"

const JSON_CONTENT_TYPE = "application/json"
const METHOD_ORDER: ReadonlyArray<Lowercase<HeraOpenApiMethod>> = ["delete", "get", "patch", "post", "put"]

function fail(operation: HeraOpenApiOperation, reason: string): never {
  throw new TypeError(`HeraOpenApi.document: operation "${operation.operationId}" ${reason}`)
}

function parametersOf(
  components: HeraOpenApiComponents,
  operation: HeraOpenApiOperation,
  schema: Schema.Top,
  location: "path" | "query"
): ReadonlyArray<HeraOpenApiParameterObject> {
  const root = components.resolve(components.add(schema, operation.operationId))
  const properties = root["properties"]
  if (typeof properties !== "object" || properties === null) {
    fail(operation, `has a ${location === "path" ? "params" : "query"} schema that is not a Struct`)
  }
  const required = Array.isArray(root["required"]) ? (root["required"] as ReadonlyArray<string>) : []
  return Object.entries(properties as Record<string, JsonSchema.JsonSchema>).map(([name, field]) => ({
    name,
    in: location,
    required: location === "path" || required.includes(name),
    schema: field,
  }))
}

function placeholdersOf(path: string): ReadonlyArray<string> {
  return [...path.matchAll(/\{([^}/]+)\}/g)].map((match) => match[1] as string).sort()
}

function operationObject(
  components: HeraOpenApiComponents,
  operation: HeraOpenApiOperation
): HeraOpenApiOperationObject {
  const pathParams =
    operation.params === undefined ? [] : parametersOf(components, operation, operation.params, "path")
  const declared = pathParams.map((p) => p.name).sort()
  const placeholders = placeholdersOf(operation.path)
  if (declared.join("\n") !== placeholders.join("\n")) {
    fail(
      operation,
      `path ${operation.path} names {${placeholders.join("}, {")}} but its params struct has [${declared.join(", ")}]`
    )
  }
  const parameters = [
    ...pathParams,
    ...(operation.query === undefined ? [] : parametersOf(components, operation, operation.query, "query")),
  ]
  const responses: Record<string, { description: string; content?: HeraOpenApiMediaTypes }> = {}
  for (const [status, response] of Object.entries(operation.responses)) {
    responses[status] =
      response.schema === undefined
        ? { description: response.description }
        : {
            description: response.description,
            content: {
              [response.contentType ?? JSON_CONTENT_TYPE]: {
                schema: components.add(response.schema, operation.operationId),
              },
            },
          }
  }
  return {
    operationId: operation.operationId,
    ...(operation.summary === undefined ? {} : { summary: operation.summary }),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(operation.body === undefined
      ? {}
      : {
          requestBody: {
            required: true as const,
            content: {
              [JSON_CONTENT_TYPE]: { schema: components.add(operation.body, operation.operationId) },
            },
          },
        }),
    responses,
    ...(operation.security === undefined ? {} : { security: operation.security }),
  }
}

/**
 * Builds the document. Throws a `TypeError` on a duplicate `operationId` or method + path, a
 * `{param}` placeholder the params struct does not declare (or the reverse), a params or query
 * schema that is not a Struct, or two different schemas sharing one identifier.
 */
export function document(spec: HeraOpenApiSpec): HeraOpenApiDocument {
  const components = new HeraOpenApiComponents()
  const byPath = new Map<string, Map<Lowercase<HeraOpenApiMethod>, HeraOpenApiOperationObject>>()
  const operationIds = new Set<string>()
  for (const operation of spec.operations) {
    if (operationIds.has(operation.operationId)) fail(operation, "is declared twice")
    operationIds.add(operation.operationId)
    const method = operation.method.toLowerCase() as Lowercase<HeraOpenApiMethod>
    const methods = byPath.get(operation.path) ?? new Map()
    if (methods.has(method)) fail(operation, `repeats ${operation.method} ${operation.path}`)
    methods.set(method, operationObject(components, operation))
    byPath.set(operation.path, methods)
  }

  const paths: Record<string, Partial<Record<Lowercase<HeraOpenApiMethod>, HeraOpenApiOperationObject>>> = {}
  for (const path of [...byPath.keys()].sort()) {
    const methods = byPath.get(path) as Map<Lowercase<HeraOpenApiMethod>, HeraOpenApiOperationObject>
    const entry: Partial<Record<Lowercase<HeraOpenApiMethod>, HeraOpenApiOperationObject>> = {}
    for (const method of METHOD_ORDER) {
      const op = methods.get(method)
      if (op !== undefined) entry[method] = op
    }
    paths[path] = entry
  }

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    info: spec.info,
    ...(spec.servers === undefined ? {} : { servers: spec.servers }),
    paths,
    components: {
      schemas: components.schemas(),
      ...(spec.securitySchemes === undefined ? {} : { securitySchemes: spec.securitySchemes }),
    },
  }
}
