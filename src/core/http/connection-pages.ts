import * as Effect from "effect/Effect"
import { HeraError } from "../errors/index.js"

/** A GraphQL connection's `pageInfo`, loose so the pager (not the decoder) rejects a bad one. */
export interface HeraConnectionPageInfo {
  readonly hasNextPage?: boolean | undefined
  readonly endCursor?: string | null | undefined
}

/** One page of a GraphQL connection: `nodes` + `pageInfo { hasNextPage endCursor }`. */
export interface HeraConnectionPage<N> {
  readonly nodes: ReadonlyArray<N>
  readonly pageInfo?: HeraConnectionPageInfo | null | undefined
}

export interface HeraConnectionPagesOptions<N, E, R> {
  /**
   * Reads one page after `after` (`null` for the first); `index` counts from 0. It runs once per
   * page, so a lease or token taken here is fresh for each page. Its error fails the whole read.
   */
  readonly page: (after: string | null, index: number) => Effect.Effect<HeraConnectionPage<N>, E, R>
  /** The most pages one read takes; a connection with more fails `truncated`. A positive integer. */
  readonly maxPages: number
}

/** `fields.reason` of the `upstream_error` a connection that cannot prove it ended fails with. */
export type HeraConnectionPagesReason = "truncated" | "missing_page_info" | "missing_end_cursor"

function upstream(reason: HeraConnectionPagesReason, fields: Readonly<Record<string, number>>): HeraError {
  return new HeraError({
    code: "upstream_error",
    httpStatus: 502,
    message: `GraphQL connection read failed: ${reason}`,
    fields: { reason, ...fields },
  })
}

/**
 * Every node of a GraphQL connection, in page order, or a failure: never a partial list. A page's
 * own error fails the read unchanged. `HeraError` `upstream_error` (502) when a page has no
 * `pageInfo.hasNextPage` (`missing_page_info`), reports `hasNextPage` with no `endCursor`
 * (`missing_end_cursor`), or `maxPages` pages still leave more (`truncated`; no page past the cap
 * is requested). `internal_error` (500, `invalid_max_pages`) before any page when `maxPages` is
 * not a positive integer.
 */
export function connectionPages<N, E, R>(
  options: HeraConnectionPagesOptions<N, E, R>
): Effect.Effect<ReadonlyArray<N>, E | HeraError, R> {
  const { page, maxPages } = options
  return Effect.gen(function* () {
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      return yield* new HeraError({
        code: "internal_error",
        httpStatus: 500,
        message: "connectionPages maxPages must be a positive integer",
        fields: { reason: "invalid_max_pages" },
      })
    }
    const nodes: N[] = []
    let after: string | null = null
    for (let index = 0; index < maxPages; index++) {
      const read: HeraConnectionPage<N> = yield* page(after, index)
      const hasNextPage = read.pageInfo?.hasNextPage
      if (typeof hasNextPage !== "boolean") {
        return yield* upstream("missing_page_info", { page: index })
      }
      nodes.push(...read.nodes)
      if (!hasNextPage) return nodes
      const cursor = read.pageInfo?.endCursor
      if (typeof cursor !== "string" || cursor.length === 0) {
        return yield* upstream("missing_end_cursor", { page: index })
      }
      after = cursor
    }
    return yield* upstream("truncated", { maxPages })
  })
}
