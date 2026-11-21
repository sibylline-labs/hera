import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type { HeraError } from "../../core/errors/index.js"
import {
  checkCustomMetadata,
  checkObjectKey,
  type HeraObjectGetResult,
  type HeraObjectHeadResult,
  type HeraObjectList,
  type HeraObjectStoreClient,
  type HeraStoredObject,
} from "../../core/object-store/index.js"
import { invalidRequest, unquoteEtag } from "../../core/object-store/metadata.js"
import { preconditionFailed } from "../../core/object-store/errors.js"

interface Entry {
  readonly object: HeraStoredObject
  readonly body: Uint8Array<ArrayBuffer>
}

/** `HeraTest.objectStore()`: the in-memory store plus a read of what it holds, for assertions. */
export interface HeraTestObjectStore extends HeraObjectStoreClient {
  /** Every held object, by key, with its body as UTF-8 text. */
  readonly snapshot: () => ReadonlyMap<string, HeraStoredObject & { readonly text: string }>
}

const refusal = (error: HeraError | null) => (error === null ? Effect.void : Effect.fail(error))

/**
 * An in-memory `HeraObjectStoreClient` with R2's precondition semantics, so consumers test
 * without network. Each write checks its precondition and commits in one synchronous step, so
 * of two racing `ifNoneMatch: "*"` puts exactly one wins. Keys and metadata are refused exactly
 * as `HeraObjectStore.r2S3` refuses them. Times come from the Effect `Clock`.
 */
export function makeTestObjectStore(): HeraTestObjectStore {
  const entries = new Map<string, Entry>()
  let writes = 0

  const commit = (
    key: string,
    body: Uint8Array<ArrayBuffer>,
    options: Parameters<HeraObjectStoreClient["put"]>[2] = {},
    uploaded: number
  ): HeraStoredObject | HeraError => {
    const current = entries.get(key)
    if (options.ifNoneMatch === "*" && current !== undefined) return preconditionFailed("put", key)
    if (
      options.ifMatch !== undefined &&
      (current === undefined || current.object.etag !== unquoteEtag(options.ifMatch))
    ) {
      return preconditionFailed("put", key)
    }
    writes += 1
    const object: HeraStoredObject = {
      key,
      etag: `${writes.toString(16).padStart(8, "0")}${body.byteLength.toString(16)}`,
      size: body.byteLength,
      uploaded,
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      customMetadata: { ...options.customMetadata },
    }
    entries.set(key, { object, body })
    return object
  }

  const head = (key: string): Effect.Effect<HeraObjectHeadResult, HeraError> =>
    refusal(checkObjectKey("head", key)).pipe(
      Effect.andThen(
        Effect.sync((): HeraObjectHeadResult => {
          const entry = entries.get(key)
          return entry === undefined ? { _tag: "NotFound" } : { _tag: "Found", object: entry.object }
        })
      )
    )

  return {
    head,
    get: (key, options = {}) =>
      refusal(checkObjectKey("get", key)).pipe(
        Effect.andThen(
          Effect.sync((): HeraObjectGetResult => {
            const entry = entries.get(key)
            if (entry === undefined) return { _tag: "NotFound" }
            const etag = options.ifNoneMatch === undefined ? undefined : unquoteEtag(options.ifNoneMatch)
            if (etag === "*" || etag === entry.object.etag) {
              return { _tag: "NotModified" }
            }
            return { _tag: "Found", object: entry.object, body: entry.body.slice() }
          })
        )
      ),
    put: (key, body, options) =>
      refusal(checkObjectKey("put", key) ?? checkCustomMetadata("put", options?.customMetadata)).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.andThen((now) => {
          const source = typeof body === "string" ? new TextEncoder().encode(body) : body
          const bytes = new Uint8Array(source.byteLength)
          bytes.set(source)
          const out = commit(key, bytes, options, now)
          return "etag" in out ? Effect.succeed(out) : Effect.fail(out)
        })
      ),
    list: (options = {}) => {
      const limit = options.limit ?? 1000
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return Effect.fail(invalidRequest("list", "limit"))
      }
      return Effect.sync((): HeraObjectList => {
        const withMetadata = options.include?.includes("customMetadata") === true
        const keys = [...entries.keys()]
          .filter((k) => k.startsWith(options.prefix ?? ""))
          .filter((k) => options.cursor === undefined || k > options.cursor)
          .sort()
        const page = keys.slice(0, limit)
        const objects = page.map((k) => {
          const { customMetadata, contentType: _contentType, ...item } = entries.get(k)!.object
          return withMetadata ? { ...item, customMetadata } : item
        })
        const truncated = keys.length > limit
        return {
          objects,
          truncated,
          ...(truncated ? { cursor: page[page.length - 1] } : {}),
        }
      })
    },
    snapshot: () =>
      new Map(
        [...entries].map(([k, e]) => [k, { ...e.object, text: new TextDecoder().decode(e.body) }])
      ),
  }
}
