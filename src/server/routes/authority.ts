import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import { type HeraAuthorityCtx, grantAuthorityCtx } from "../../core/authority/ctx.js"
import {
  type HeraAuthorityRequest,
  HeraAuthorityRefusal,
  HeraAuthorityVerifier,
  refuseAuthority,
} from "../../core/authority/types.js"
import { type AnyHeraDefinedError, HeraError } from "../../core/errors/index.js"
import { HeraHttpError, RateLimitedError } from "../../core/http/errors.js"
import { cleanAuthorityFields, cleanAuthorityText, isUnsafeAuthorityText } from "./authority-redact.js"
import type { HeraAuthedRouteContext, HeraAuthedRouteSpec } from "./types.js"

/**
 * An authority check over a route ctx `C`: the verb the caller must be granted, where its
 * credential comes from in the decoded request, and the verifier that decides.
 */
export interface HeraRouteAuthorityFor<C, V extends string> {
  /** The authority verb (`"domain:action"` by convention); the handler's ctx is typed by it. */
  readonly verb: V
  /** Reads the caller's credential from the decoded request; `undefined` or empty refuses. */
  readonly credential: (ctx: C) => Redacted.Redacted<string> | string | undefined
  /** Request params the verifier matches against the grant (default `{}`). */
  readonly params?: ((ctx: C) => Readonly<Record<string, string>>) | undefined
  /** The verifier port, provided only to the one `verify` call. */
  readonly verifier: Layer.Layer<HeraAuthorityVerifier, HeraError | AnyHeraDefinedError>
}

/**
 * A `Hera.authedRoute` guarded by an authority check: the handler runs only after
 * `authority.verifier` grants `authority.verb`, and receives the grant as `HeraAuthorityCtx<V>`.
 */
export interface HeraAuthorityRouteSpec<
  ParamsSchema extends Schema.Top | undefined,
  QuerySchema extends Schema.Top | undefined,
  HeadersSchema extends Schema.Top | undefined,
  BodySchema extends Schema.Top | undefined,
  A,
  E,
  R,
  V extends string,
> extends Omit<
    HeraAuthedRouteSpec<ParamsSchema, QuerySchema, HeadersSchema, BodySchema, A, E, R>,
    "authority" | "handler"
  > {
  readonly authority: HeraRouteAuthorityFor<
    HeraAuthedRouteContext<ParamsSchema, QuerySchema, HeadersSchema, BodySchema>,
    V
  >
  readonly handler: (
    ctx: HeraAuthedRouteContext<ParamsSchema, QuerySchema, HeadersSchema, BodySchema>,
    authority: HeraAuthorityCtx<NoInfer<V>>
  ) => Effect.Effect<A, E, R>
}

/**
 * The fixed defect a guarded route dies with when any part of its authority step throws: the
 * credential or params reader, the verifier, its layer, or the error mapping. It carries no field
 * of the thrown value, so the boundary's defect log names this class and nothing else.
 */
export class HeraAuthorityVerifierDefect extends Error {
  readonly _tag = "HeraAuthorityVerifierDefect"
  constructor() {
    super("authority verifier defect")
    this.name = "HeraAuthorityVerifierDefect"
  }
}

function readCredential(
  raw: Redacted.Redacted<string> | string | undefined
): Redacted.Redacted<string> | undefined {
  if (raw === undefined) return undefined
  const credential = Redacted.isRedacted(raw) ? raw : Redacted.make(raw)
  return Redacted.value(credential).length === 0 ? undefined : credential
}

/** The typed retryable 503 for a verifier that could not answer; it renders no verifier text. */
function verifierUnavailable(retryAfter?: number | undefined): HeraError {
  return HeraError.serviceUnavailable("Authority verifier unavailable", {
    fields: { slug: "authority-verifier-unavailable", retryable: true },
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  })
}

/**
 * Maps any failure of the verification step to a `HeraError` with no credential in it, cleaned on
 * the raw text before the error constructor runs, and with the cause and issues dropped. A refusal
 * keeps the verifier's slug unless the slug is unsafe (`authority-refused`); a transport failure,
 * an uncatalogued failure, or a layer error whose `code` is unsafe is the typed retryable 503.
 */
function toRouteError(err: unknown, secret: string): HeraError | HeraAuthorityRefusal {
  if (HeraAuthorityRefusal.is(err)) {
    return refuseAuthority(isUnsafeAuthorityText(err.slug, secret) ? "authority-refused" : err.slug, {
      what: cleanAuthorityText(err.what, secret),
      ...(err.fix !== undefined ? { fix: cleanAuthorityText(err.fix, secret) } : {}),
    })
  }
  if (RateLimitedError.is(err)) return verifierUnavailable(err.retryAfterSeconds ?? undefined)
  if (HeraHttpError.is(err)) return verifierUnavailable()
  const base = HeraError.is(err) ? err : HeraError.isDefinedError(err) ? err.toHeraError() : undefined
  if (base === undefined || isUnsafeAuthorityText(base.code, secret)) return verifierUnavailable()
  const fields = cleanAuthorityFields(base.fields, secret)
  return new HeraError({
    code: base.code,
    httpStatus: base.httpStatus,
    publicMessage: cleanAuthorityText(base.publicMessage, secret),
    ...(base.retryAfter !== undefined ? { retryAfter: base.retryAfter } : {}),
    ...(fields !== undefined ? { fields } : {}),
  })
}

/**
 * Runs the authority check for one guarded request. Reads the credential once and refuses
 * `authority-credential-missing` without calling the verifier when it is absent; otherwise asks
 * the verifier, provided only to that call. Every failure passes through `toRouteError`, and any
 * throw in the whole step becomes `HeraAuthorityVerifierDefect`, so no path renders the credential.
 */
export function authorizeRoute<C, V extends string>(
  operation: string,
  authority: HeraRouteAuthorityFor<C, V>,
  ctx: C
): Effect.Effect<HeraAuthorityCtx<V>, HeraError | HeraAuthorityRefusal> {
  const step = Effect.suspend(() => {
    const credential = readCredential(authority.credential(ctx))
    if (credential === undefined) {
      return Effect.fail(
        refuseAuthority("authority-credential-missing", {
          what: `no credential was supplied for '${authority.verb}'`,
          fix: "Send the credential this route expects and retry.",
        })
      )
    }
    const request: HeraAuthorityRequest = {
      verb: authority.verb,
      params: authority.params?.(ctx) ?? {},
      credential,
      command: operation,
    }
    const secret = Redacted.value(credential)
    return Effect.provide(
      Effect.flatMap(Effect.service(HeraAuthorityVerifier), (verifier) => verifier.verify(request)),
      authority.verifier
    ).pipe(
      Effect.mapBoth({
        onFailure: (err) => toRouteError(err, secret),
        onSuccess: (grant) => grantAuthorityCtx(authority.verb, request, grant),
      })
    )
  })
  return step.pipe(Effect.catchDefect(() => Effect.die(new HeraAuthorityVerifierDefect())))
}
