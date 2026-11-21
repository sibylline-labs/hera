import * as Schema from "effect/Schema";
import { TaggedError } from "effect/Schema";
import { type HeraHttpError, RateLimitedError } from "../../core/http/index.js";
import { ErrorSlug } from "../../core/schema/index.js";
import { scrubFreeText } from "./scrubber.js";

/**
 * Canonical Eris CLI non-zero exit codes:
 * - `1`: operational failure
 * - `2`: usage / CLI argument validation error
 * - `3`: precondition failure
 * - `124`: command or network timeout
 */
export const ErisExitCodeSchema = Schema.Literals([1, 2, 3, 124]);
export type ErisExitCode = typeof ErisExitCodeSchema.Type;

export interface ErisErrorFields {
  readonly what: string;
  readonly fix?: string | undefined;
  readonly docs?: string | undefined;
  readonly cause?: unknown;
}

export function toErrorSlug(slug: ErrorSlug | string): ErrorSlug {
  return ErrorSlug.is(slug) ? slug : ErrorSlug.make(slug);
}

/**
 * Canonical tagged CLI error for Eris / Hera CLI verbs.
 *
 * Built on Effect v4 `Schema.TaggedError` with factory constructors for the
 * four Eris exit-code classes:
 * - `ErisError.operational(slug, fields)` -> `exitCode: 1`
 * - `ErisError.usage(slug, fields)` -> `exitCode: 2`
 * - `ErisError.precondition(slug, fields)` -> `exitCode: 3`
 * - `ErisError.timeout(slug, fields)` -> `exitCode: 124`
 */
export class ErisError extends TaggedError<ErisError>()("ErisError", {
  slug: ErrorSlug,
  what: Schema.String,
  fix: Schema.optional(Schema.String),
  docs: Schema.optional(Schema.String),
  exitCode: ErisExitCodeSchema,
  cause: Schema.optional(Schema.Unknown),
}) {
  static is(u: unknown): u is ErisError {
    return (
      typeof u === "object" &&
      u !== null &&
      "_tag" in u &&
      (u as { readonly _tag?: unknown })._tag === "ErisError"
    );
  }

  static operational(
    slug: ErrorSlug | string,
    fields: ErisErrorFields,
  ): ErisError {
    return new ErisError({
      slug: toErrorSlug(slug),
      what: scrubFreeText(fields.what).text,
      ...(fields.fix !== undefined
        ? { fix: scrubFreeText(fields.fix).text }
        : {}),
      ...(fields.docs !== undefined
        ? { docs: scrubFreeText(fields.docs).text }
        : {}),
      exitCode: 1,
      ...(fields.cause !== undefined ? { cause: fields.cause } : {}),
    });
  }

  static usage(slug: ErrorSlug | string, fields: ErisErrorFields): ErisError {
    return new ErisError({
      slug: toErrorSlug(slug),
      what: scrubFreeText(fields.what).text,
      ...(fields.fix !== undefined
        ? { fix: scrubFreeText(fields.fix).text }
        : {}),
      ...(fields.docs !== undefined
        ? { docs: scrubFreeText(fields.docs).text }
        : {}),
      exitCode: 2,
      ...(fields.cause !== undefined ? { cause: fields.cause } : {}),
    });
  }

  static precondition(
    slug: ErrorSlug | string,
    fields: ErisErrorFields,
  ): ErisError {
    return new ErisError({
      slug: toErrorSlug(slug),
      what: scrubFreeText(fields.what).text,
      ...(fields.fix !== undefined
        ? { fix: scrubFreeText(fields.fix).text }
        : {}),
      ...(fields.docs !== undefined
        ? { docs: scrubFreeText(fields.docs).text }
        : {}),
      exitCode: 3,
      ...(fields.cause !== undefined ? { cause: fields.cause } : {}),
    });
  }

  static timeout(slug: ErrorSlug | string, fields: ErisErrorFields): ErisError {
    return new ErisError({
      slug: toErrorSlug(slug),
      what: scrubFreeText(fields.what).text,
      ...(fields.fix !== undefined
        ? { fix: scrubFreeText(fields.fix).text }
        : {}),
      ...(fields.docs !== undefined
        ? { docs: scrubFreeText(fields.docs).text }
        : {}),
      exitCode: 124,
      ...(fields.cause !== undefined ? { cause: fields.cause } : {}),
    });
  }

  static fromHttpError(err: RateLimitedError | HeraHttpError): ErisError {
    if (RateLimitedError.is(err)) {
      const retryHint =
        err.retryAfterSeconds !== null
          ? `Wait ${err.retryAfterSeconds}s before retrying.`
          : "Wait before retrying the request.";
      return ErisError.operational(err.slug, {
        what: err.message,
        fix: retryHint,
        cause: err,
      });
    }
    if (err.reason === "Timeout") {
      return ErisError.timeout(err.slug, {
        what: err.message,
        fix: "Check network connectivity or increase the request timeout.",
        cause: err,
      });
    }
    return ErisError.operational(err.slug, {
      what: err.message,
      cause: err,
    });
  }

  override get message(): string {
    return scrubFreeText(this.what).text;
  }
}

/**
 * Alias for `ErisError` matching `Schema.TaggedErrorClass` naming conventions.
 */
export const ErisErrorClass = ErisError;
