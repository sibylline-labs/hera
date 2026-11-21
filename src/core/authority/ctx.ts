import type * as Redacted from "effect/Redacted"
import type { HeraAuthorityGrant, HeraAuthorityRequest } from "./types.js"

/** Private brand: only `grantAuthorityCtx` can build a `HeraAuthorityCtx`. */
declare const authorityBrand: unique symbol

/**
 * Proof that a verifier granted `verb` for this run. A boundary hands it to the handler it guards;
 * the brand keeps an object literal from standing in for it.
 */
export interface HeraAuthorityCtx<V extends string> {
  readonly [authorityBrand]: V
  readonly verb: V
  readonly params: Readonly<Record<string, string>>
  readonly credential: Redacted.Redacted<string>
  readonly grant: HeraAuthorityGrant
}

/**
 * Builds the ctx after a successful `verify`. Boundary-internal: no barrel or package subpath
 * exports it.
 */
export function grantAuthorityCtx<V extends string>(
  verb: V,
  request: HeraAuthorityRequest,
  grant: HeraAuthorityGrant
): HeraAuthorityCtx<V> {
  return {
    verb,
    params: request.params,
    credential: request.credential,
    grant,
  } as HeraAuthorityCtx<V>
}
