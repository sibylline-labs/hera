import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import { type HeraAuthorityCtx, grantAuthorityCtx } from "../../core/authority/ctx.js";
import {
  type HeraAuthorityError,
  type HeraAuthorityRequest,
  HeraAuthorityRefusal,
  HeraAuthorityVerifier,
} from "../../core/authority/types.js";
import { ErrorSlug } from "../../core/schema/index.js";
import { ErisError } from "../errors/eris-error.js";
import { scrubFreeText } from "../errors/scrubber.js";
import type { HeraCliCtxShape } from "./cli-ctx.js";

type DecodedArgs<S extends Schema.Top | undefined> = S extends Schema.Top
  ? S["Type"]
  : undefined;

/**
 * An authority check over decoded args `A`: the verb the caller must be granted, where its
 * credential comes from, and the verifier that decides.
 */
export interface HeraCliAuthorityFor<A, V extends string> {
  /** The authority verb (`"domain:action"` by convention); the handler's ctx is typed by it. */
  readonly verb: V;
  /** Reads the caller's credential (a flag or an env value); `undefined` or empty refuses. */
  readonly credential: (
    args: A,
    ctx: HeraCliCtxShape,
  ) => Redacted.Redacted<string> | string | undefined;
  /** Request params the verifier matches against the grant (default `{}`). */
  readonly params?: ((args: A) => Readonly<Record<string, string>>) | undefined;
  /** The verifier port, provided only to the one `verify` call. */
  readonly verifier: Layer.Layer<HeraAuthorityVerifier, ErisError>;
}

/** The `authority` option of `HeraCli.verb`, over the args its schema `S` decodes. */
export type HeraCliAuthority<
  S extends Schema.Top | undefined,
  V extends string,
> = HeraCliAuthorityFor<DecodedArgs<S>, V>;

const CREDENTIAL_MISSING = ErrorSlug.make("authority-credential-missing");

function readCredential(
  raw: Redacted.Redacted<string> | string | undefined,
): Redacted.Redacted<string> | undefined {
  if (raw === undefined) return undefined;
  const credential = Redacted.isRedacted(raw) ? raw : Redacted.make(raw);
  return Redacted.value(credential).length === 0 ? undefined : credential;
}

const REFUSED = ErrorSlug.make("authority-refused");
const REDACTED_MARK = "[REDACTED]";

/** Replaces every occurrence of the exact credential; a pattern scrubber misses opaque values. */
function redact(text: string, secret: string): string {
  return text.split(secret).join(REDACTED_MARK);
}

function safeSlug(slug: ErrorSlug, secret: string): ErrorSlug {
  return slug.includes(secret) ? REFUSED : slug;
}

/**
 * Maps any failure of the verification step to an `ErisError` with the exact credential removed.
 * Verifier-built text (a refusal's what/fix/code, a transport URL, a layer build error) may echo
 * it, and a pattern scrubber misses opaque values or rewrites part of one, so the exact value is
 * redacted from the raw text first, then scrubbed. The cause is dropped: it holds the raw text.
 */
function toErisError(
  command: string,
  err: HeraAuthorityError | ErisError,
  credential: Redacted.Redacted<string>,
): ErisError {
  const secret = Redacted.value(credential);
  const clean = (text: string): string => redact(text, secret);
  if (ErisError.is(err)) {
    return new ErisError({
      slug: safeSlug(err.slug, secret),
      what: clean(err.what),
      ...(err.fix !== undefined ? { fix: clean(err.fix) } : {}),
      ...(err.docs !== undefined ? { docs: clean(err.docs) } : {}),
      exitCode: err.exitCode,
    });
  }
  if (HeraAuthorityRefusal.is(err)) {
    return ErisError.precondition(safeSlug(err.slug, secret), {
      what: `${command}: ${clean(err.what)}`,
      ...(err.fix !== undefined ? { fix: clean(err.fix) } : {}),
    });
  }
  const mapped = ErisError.fromHttpError(err);
  return new ErisError({
    slug: safeSlug(mapped.slug, secret),
    what: scrubFreeText(clean(err.message)).text,
    ...(mapped.fix !== undefined ? { fix: clean(mapped.fix) } : {}),
    exitCode: mapped.exitCode,
  });
}

/**
 * Runs the authority check for one verb run. Reads the credential once, fails closed when it is
 * absent (the verifier is not called), and otherwise asks the verifier. A refusal becomes an
 * `ErisError.precondition` (exit 3) whose slug is the verifier's code; a transport failure maps
 * through `ErisError.fromHttpError`. Every failure of the step, the verifier layer's build
 * included, passes through `toErisError`, so no path renders the credential.
 */
export function authorize<A, V extends string>(
  command: string,
  authority: HeraCliAuthorityFor<A, V>,
  args: A,
  ctx: HeraCliCtxShape,
): Effect.Effect<HeraAuthorityCtx<V>, ErisError> {
  const credential = readCredential(authority.credential(args, ctx));
  if (credential === undefined) {
    return Effect.fail(
      ErisError.precondition(CREDENTIAL_MISSING, {
        what: `${command}: no credential was supplied for '${authority.verb}'`,
        fix: `Pass the credential '${command}' expects (its flag or environment variable) and run again.`,
      }),
    );
  }
  const request: HeraAuthorityRequest = {
    verb: authority.verb,
    params: authority.params?.(args) ?? {},
    credential,
    command,
  };
  const verified = Effect.provide(
    Effect.flatMap(Effect.service(HeraAuthorityVerifier), (verifier) => verifier.verify(request)),
    authority.verifier,
  );
  return Effect.mapBoth(verified, {
    onFailure: (err) => toErisError(command, err, credential),
    onSuccess: (grant) => grantAuthorityCtx(authority.verb, request, grant),
  });
}
