import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import {
  type HeraAuthorityGrant,
  HeraAuthorityVerifier,
  refuseAuthority,
} from "../../core/authority/index.js"

/** One verb's answer in a `HeraTest.authority` spec: a grant, or a refusal with its code. */
export type HeraTestAuthorityRule =
  | { readonly grant: HeraAuthorityGrant }
  | { readonly refuse: { readonly slug: string; readonly what?: string | undefined } }

export interface HeraTestAuthoritySpec {
  /** The answer per authority verb. A verb with no rule is refused `authority-not-granted`. */
  readonly verbs?: Readonly<Record<string, HeraTestAuthorityRule>> | undefined
  /** When set, any other credential is refused `authority-credential-rejected`. */
  readonly credential?: string | undefined
}

/** What the fake saw for one `verify` call. The credential is never recorded. */
export interface HeraTestAuthorityRequest {
  readonly verb: string
  readonly params: Readonly<Record<string, string>>
  readonly command: string
}

/** `HeraTest.authority(spec)`: a verifier Layer over an in-memory spec, plus its call log. */
export interface HeraTestAuthority {
  readonly layer: Layer.Layer<HeraAuthorityVerifier>
  /** Every `verify` call, in order, without the credential. */
  readonly requests: ReadonlyArray<HeraTestAuthorityRequest>
  /** Grants `verb` from now on (default grant id `test-grant`). */
  readonly grant: (verb: string, grant?: HeraAuthorityGrant) => void
  /** Refuses `verb` from now on with `slug`. */
  readonly refuse: (verb: string, slug: string, what?: string) => void
}

const DEFAULT_GRANT: HeraAuthorityGrant = { id: "test-grant" }

/**
 * An in-memory `HeraAuthorityVerifier`. Tests hand its `layer` to a verb's `authority.verifier` and
 * steer it with `grant` / `refuse`; it fails closed for any verb it was not told about.
 */
export function makeTestAuthority(spec: HeraTestAuthoritySpec = {}): HeraTestAuthority {
  const rules = new Map<string, HeraTestAuthorityRule>(Object.entries(spec.verbs ?? {}))
  const requests: HeraTestAuthorityRequest[] = []

  const layer = HeraAuthorityVerifier.layer({
    verify: (request) =>
      Effect.suspend(() => {
        requests.push({ verb: request.verb, params: request.params, command: request.command })
        if (spec.credential !== undefined && Redacted.value(request.credential) !== spec.credential) {
          return Effect.fail(
            refuseAuthority("authority-credential-rejected", { what: "the credential was not recognised" })
          )
        }
        const rule = rules.get(request.verb)
        if (rule === undefined) {
          return Effect.fail(
            refuseAuthority("authority-not-granted", { what: `no grant covers '${request.verb}'` })
          )
        }
        if ("grant" in rule) return Effect.succeed(rule.grant)
        return Effect.fail(
          refuseAuthority(rule.refuse.slug, { what: rule.refuse.what ?? `'${request.verb}' was refused` })
        )
      }),
  })

  return {
    layer,
    requests,
    grant: (verb, grant = DEFAULT_GRANT) => {
      rules.set(verb, { grant })
    },
    refuse: (verb, slug, what) => {
      rules.set(verb, { refuse: { slug, what } })
    },
  }
}
