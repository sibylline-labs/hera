import { document } from "./document.js"

export type * from "./types.js"

/**
 * OpenAPI 3.1 from Effect schemas: `document(spec)` turns a table of operations into
 * one document whose `$ref`s all resolve inside `components.schemas`.
 */
export const HeraOpenApi = {
  document,
} as const
