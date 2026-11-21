/**
 * `@sibylline-labs/hera/authority`: the product-neutral authority port. A boundary
 * (`HeraCli.verb`'s or `Hera.authedRoute`'s `authority` option) asks `HeraAuthorityVerifier` whether a credential may
 * perform a verb, and hands the guarded handler a `HeraAuthorityCtx<V>` only on a grant.
 */
export type { HeraAuthorityCtx } from "./ctx.js"
export {
  type HeraAuthorityError,
  type HeraAuthorityGrant,
  HeraAuthorityRefusal,
  type HeraAuthorityRefusalFields,
  type HeraAuthorityRequest,
  HeraAuthorityVerifier,
  type HeraAuthorityVerifierShape,
  refuseAuthority,
} from "./types.js"
