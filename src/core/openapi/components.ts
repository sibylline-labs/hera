/**
 * Effect schemas → OpenAPI 3.1 JSON Schemas sharing one `components.schemas` pool.
 *
 * Effect generates each schema (`Schema.toJsonSchemaDocument`) and rewrites its refs to
 * `#/components/schemas/<name>` (`JsonSchema.toMultiDocumentOpenApi3_1`); this module only merges
 * the per-schema definitions, refusing two different definitions under one name.
 */

import * as JsonSchema from "effect/JsonSchema"
import * as Schema from "effect/Schema"

const COMPONENT_REF_PREFIX = "#/components/schemas/"

/** Collects definitions by name; a name is bound to exactly one JSON Schema. */
export class HeraOpenApiComponents {
  private readonly pool = new Map<string, { readonly schema: JsonSchema.JsonSchema; readonly key: string }>()

  /** The OpenAPI JSON Schema for `schema`, with its definitions merged into the pool. */
  add(schema: Schema.Top, owner: string): JsonSchema.JsonSchema {
    const doc = Schema.toJsonSchemaDocument(schema)
    const openApi = JsonSchema.toMultiDocumentOpenApi3_1({
      dialect: doc.dialect,
      schemas: [doc.schema],
      definitions: doc.definitions,
    })
    for (const [name, definition] of Object.entries(openApi.definitions)) {
      const key = canonicalJson(definition)
      const held = this.pool.get(name)
      if (held === undefined) {
        this.pool.set(name, { schema: definition, key })
      } else if (held.key !== key) {
        throw new TypeError(
          `HeraOpenApi.document: two different schemas share the identifier "${name}" (seen again in ${owner}); give one a distinct identifier`
        )
      }
    }
    return openApi.schemas[0]
  }

  /** Follows a root `$ref` into the pool, so a Struct with an identifier still exposes `properties`. */
  resolve(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
    const ref = schema["$ref"]
    if (typeof ref === "string" && ref.startsWith(COMPONENT_REF_PREFIX)) {
      const held = this.pool.get(ref.slice(COMPONENT_REF_PREFIX.length))
      if (held !== undefined) return this.resolve(held.schema)
    }
    return schema
  }

  /** The pool, keys sorted. */
  schemas(): Record<string, JsonSchema.JsonSchema> {
    const out: Record<string, JsonSchema.JsonSchema> = {}
    for (const name of [...this.pool.keys()].sort()) {
      out[name] = (this.pool.get(name) as { readonly schema: JsonSchema.JsonSchema }).schema
    }
    return out
  }
}

/** JSON with object keys sorted, so two structurally equal schemas compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  )
}
