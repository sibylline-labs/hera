import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { HeraHttpError, RateLimitedError } from "../http/index.js"
import { HeraError } from "../errors/index.js"
import { ErrorSlug } from "../schema/index.js"

/**
 * What a boundary asks the verifier: may the holder of `credential` perform `verb` with `params`?
 * `command` names the caller (a CLI verb name, or a route's operation name) for the verifier's audit trail. The credential is
 * `Redacted` so it never renders through `String()`, `JSON.stringify` or a log line.
 */
export interface HeraAuthorityRequest {
  readonly verb: string
  readonly params: Readonly<Record<string, string>>
  readonly credential: Redacted.Redacted<string>
  readonly command: string
}

/** The verifier's yes: an id for the grant it issued, and any string attributes it reports. */
export interface HeraAuthorityGrant {
  readonly id: string
  readonly attributes?: Readonly<Record<string, string>> | undefined
}

/**
 * The verifier's typed no. `slug` is the verifier's own refusal code (a kebab-case `ErrorSlug`); a
 * boundary surfaces it unchanged, so callers can branch on it. Its wire code is `forbidden` (403).
 * `what` and `fix` never carry the credential.
 */
export const HeraAuthorityRefusal = HeraError.define("HeraAuthorityRefusal", {
  code: "forbidden",
  publicMessage: "Authority refused",
  fields: {
    slug: ErrorSlug,
    what: Schema.String,
    fix: Schema.optional(Schema.String),
  },
})
export type HeraAuthorityRefusal = InstanceType<typeof HeraAuthorityRefusal>

/** Fields for `refuseAuthority`. */
export interface HeraAuthorityRefusalFields {
  readonly what: string
  readonly fix?: string | undefined
}

/** Builds a `HeraAuthorityRefusal` from a plain kebab-case code. */
export function refuseAuthority(slug: ErrorSlug | string, fields: HeraAuthorityRefusalFields): HeraAuthorityRefusal {
  return new HeraAuthorityRefusal({
    slug: ErrorSlug.is(slug) ? slug : ErrorSlug.make(slug),
    what: fields.what,
    ...(fields.fix !== undefined ? { fix: fields.fix } : {}),
  })
}

/** Every way a verification can fail: a refusal, or the verifier's transport failing. */
export type HeraAuthorityError = HeraAuthorityRefusal | HeraHttpError | RateLimitedError

/** The verifier port a product client implements. */
export interface HeraAuthorityVerifierShape {
  readonly verify: (request: HeraAuthorityRequest) => Effect.Effect<HeraAuthorityGrant, HeraAuthorityError>
}

/**
 * The authority verifier port. A boundary provides one per run; a product package implements it
 * over its own service, and tests use `HeraTest.authority(spec)`.
 */
export class HeraAuthorityVerifier extends Context.Service<HeraAuthorityVerifier, HeraAuthorityVerifierShape>()(
  "@sibylline-labs/hera/HeraAuthorityVerifier"
) {
  static layer(shape: HeraAuthorityVerifierShape): Layer.Layer<HeraAuthorityVerifier> {
    return Layer.succeed(HeraAuthorityVerifier, shape)
  }
}
