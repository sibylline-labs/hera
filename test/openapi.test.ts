import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { HeraOpenApi, type HeraOpenApiOperation } from "../src/core/openapi/index"

// A small framework-local API: two shared components, a path param, a query, a body and an
// error response, so every branch of the document builder runs without a product contract.
const Part = Schema.Struct({ sku: Schema.String, qty: Schema.Int }).annotate({ identifier: "Part" })
const Widget = Schema.Struct({ id: Schema.String, name: Schema.String, parts: Schema.Array(Part) }).annotate({
  identifier: "Widget",
})
const Problem = Schema.Struct({ type: Schema.String, status: Schema.Int }).annotate({ identifier: "Problem" })

const OPERATIONS: ReadonlyArray<HeraOpenApiOperation> = [
  {
    operationId: "widgetsCreate",
    method: "POST",
    path: "/v1/widgets",
    security: [{ bearer: [] }],
    body: Schema.Struct({ name: Schema.String, parts: Schema.Array(Part) }),
    responses: { "201": { description: "created", schema: Widget }, default: { description: "error", schema: Problem, contentType: "application/problem+json" } },
  },
  {
    operationId: "widgetsGet",
    method: "GET",
    path: "/v1/widgets/{widget_id}",
    params: Schema.Struct({ widget_id: Schema.String }),
    responses: { "200": { description: "ok", schema: Widget }, "404": { description: "missing", schema: Problem } },
  },
  {
    operationId: "partsList",
    method: "GET",
    path: "/v1/parts",
    query: Schema.Struct({ cursor: Schema.optional(Schema.String) }),
    responses: { "200": { description: "ok", schema: Schema.Array(Part) } },
  },
]

const widgetsDocument = () =>
  HeraOpenApi.document({
    info: { title: "Widgets", version: "1.0.0" },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    operations: OPERATIONS,
  })

function refsOf(value: unknown, out: Array<string> = []): Array<string> {
  if (Array.isArray(value)) {
    for (const item of value) refsOf(item, out)
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") out.push(child)
      else refsOf(child, out)
    }
  }
  return out
}

describe("HeraOpenApi.document", () => {
  // admits: map-iteration order leaking into the output, so a regenerated spec diffs with no
  // contract change; key order is invisible to types and to deep equality.
  it("is byte-identical across calls and sorts paths, methods and component names", () => {
    const first = JSON.stringify(widgetsDocument(), null, 2)
    expect(JSON.stringify(widgetsDocument(), null, 2)).toBe(first)
    const doc = widgetsDocument()
    const paths = Object.keys(doc.paths)
    expect(paths).toEqual([...paths].sort())
    const names = Object.keys(doc.components.schemas)
    expect(names).toEqual([...names].sort())
    expect(names).toEqual(expect.arrayContaining(["Part", "Problem", "Widget"]))
  })

  // admits: a `$ref` left pointing at `#/$defs/...` or at a definition never merged into
  // components, which every OpenAPI consumer rejects; JSON Schema output is untyped.
  it("resolves every $ref inside components.schemas", () => {
    const doc = widgetsDocument()
    const refs = refsOf(doc)
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/"), ref).toBe(true)
      expect(doc.components.schemas[ref.slice("#/components/schemas/".length)], ref).toBeDefined()
    }
    const operations = Object.values(doc.paths).flatMap((byMethod) => Object.keys(byMethod))
    expect(operations).toHaveLength(OPERATIONS.length)
  })

  // admits: two different schemas sharing an identifier silently overwriting one another in
  // components, so one operation documents the other's shape; a runtime merge no type checks.
  it("throws on two different definitions under one name and dedupes identical ones", () => {
    const op = (operationId: string, p: string, schema: Schema.Top): HeraOpenApiOperation => ({
      operationId,
      method: "POST",
      path: p,
      body: Schema.Struct({ value: schema }),
      responses: { "200": { description: "ok" } },
    })
    const Shared = Schema.String.annotate({ identifier: "Shared" })
    const same = HeraOpenApi.document({
      info: { title: "t", version: "1" },
      operations: [op("a", "/a", Shared), op("b", "/b", Shared)],
    })
    expect(Object.keys(same.components.schemas)).toEqual(["Shared"])

    const Other = Schema.Int.annotate({ identifier: "Shared" })
    expect(() =>
      HeraOpenApi.document({
        info: { title: "t", version: "1" },
        operations: [op("a", "/a", Shared), op("b", "/b", Other)],
      })
    ).toThrow(/Shared/)
  })

  // admits: a path template whose `{name}` placeholders disagree with the params struct, which
  // yields an invalid OpenAPI document; the path is a plain string to the type checker.
  it("throws when a path's {param} placeholders disagree with the params struct", () => {
    expect(() =>
      HeraOpenApi.document({
        info: { title: "t", version: "1" },
        operations: [
          {
            operationId: "get",
            method: "GET",
            path: "/things/{thing_id}",
            params: Schema.Struct({ id: Schema.String }),
            responses: { "200": { description: "ok" } },
          },
        ],
      })
    ).toThrow(/thing_id/)
  })
})
