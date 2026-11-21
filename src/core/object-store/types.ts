import type * as Effect from "effect/Effect"
import type { HeraError } from "../errors/index.js"

/**
 * One stored object's metadata, shaped like a Worker `R2Object` so a binding adapter is a thin
 * map: `etag` is unquoted (the binding's `etag`, not `httpEtag`).
 */
export interface HeraStoredObject {
  readonly key: string
  readonly etag: string
  readonly size: number
  /** Last write time, epoch ms. */
  readonly uploaded: number
  readonly contentType?: string | undefined
  readonly customMetadata: Readonly<Record<string, string>>
}

export type HeraObjectGetResult =
  | {
      readonly _tag: "Found"
      readonly object: HeraStoredObject
      readonly body: Uint8Array<ArrayBuffer>
    }
  | { readonly _tag: "NotFound" }
  /** `ifNoneMatch` named the current etag: the caller's copy is current. */
  | { readonly _tag: "NotModified" }

export type HeraObjectHeadResult =
  | { readonly _tag: "Found"; readonly object: HeraStoredObject }
  | { readonly _tag: "NotFound" }

export interface HeraObjectGetOptions {
  /** An etag the caller already holds; equal to the current one yields `NotModified`. */
  readonly ifNoneMatch?: string | undefined
}

export interface HeraObjectPutOptions {
  /** Write only if the current etag equals this one (optimistic concurrency). */
  readonly ifMatch?: string | undefined
  /** `"*"`: write only if the key does not exist yet. */
  readonly ifNoneMatch?: "*" | undefined
  /**
   * Keys match `^[a-z0-9][a-z0-9_-]{0,127}$`, values are printable ASCII with no edge whitespace,
   * so metadata reads back identically over S3 headers and a Worker binding.
   */
  readonly customMetadata?: Readonly<Record<string, string>> | undefined
  readonly contentType?: string | undefined
}

export interface HeraObjectListOptions {
  readonly prefix?: string | undefined
  /** Page size, 1–1000 (default 1000). */
  readonly limit?: number | undefined
  /** The `cursor` of the previous page. */
  readonly cursor?: string | undefined
  /** As `R2ListOptions.include`: without it, listed objects carry empty `customMetadata`. */
  readonly include?: ReadonlyArray<"customMetadata"> | undefined
}

export interface HeraObjectListItem {
  readonly key: string
  readonly etag: string
  readonly size: number
  readonly uploaded: number
  /** Present only when listed with `include: ["customMetadata"]`. */
  readonly customMetadata?: Readonly<Record<string, string>> | undefined
}

export interface HeraObjectList {
  readonly objects: ReadonlyArray<HeraObjectListItem>
  readonly truncated: boolean
  /** Pass to the next `list` call while `truncated`. */
  readonly cursor?: string | undefined
}

/**
 * An object store with etags, conditional writes and custom metadata. Every failure is
 * a closed `HeraError`: a failed `ifMatch` / `ifNoneMatch: "*"` is `precondition_failed` (412).
 */
export interface HeraObjectStoreClient {
  readonly get: (
    key: string,
    options?: HeraObjectGetOptions
  ) => Effect.Effect<HeraObjectGetResult, HeraError>
  readonly put: (
    key: string,
    body: Uint8Array | string,
    options?: HeraObjectPutOptions
  ) => Effect.Effect<HeraStoredObject, HeraError>
  readonly head: (key: string) => Effect.Effect<HeraObjectHeadResult, HeraError>
  readonly list: (
    options?: HeraObjectListOptions
  ) => Effect.Effect<HeraObjectList, HeraError>
}

export type HeraObjectStoreOp = "get" | "put" | "head" | "list" | "credentials"
