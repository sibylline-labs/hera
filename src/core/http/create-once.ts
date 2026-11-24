import * as Effect from "effect/Effect"
import { HeraError } from "../errors/index.js"
import { HeraHttpError, RateLimitedError } from "./errors.js"

/**
 * What `createOnce` answered: `Created` is the create's own success, `Found` the entity an earlier
 * attempt wrote under the same id (its reply was lost), read back by that id.
 */
export type HeraCreateOnce<A, F> =
  | { readonly _tag: "Created"; readonly value: A }
  | { readonly _tag: "Found"; readonly value: F }

export interface HeraCreateOnceOptions<A, E, R, F, E2, R2> {
  /** The create, sent under an id the caller chose (e.g. a Linear `issueCreate` with `input.id`). */
  readonly create: Effect.Effect<A, E, R>
  /** The read-back by that same id: `null` when nothing holds it. */
  readonly find: Effect.Effect<F | null, E2, R2>
  /**
   * True when the entity found is this create's own write (same parent, same body). False fails
   * `HeraError` `conflict`. Unset, any entity under the id is taken as this create's.
   */
  readonly owns?: ((found: F) => boolean) | undefined
  /**
   * True for a failure that proves nothing was written, so no read-back is spent. Unset, a rate
   * limit is definitive: `RateLimitedError`, a `HeraHttpError` carrying a `RATELIMITED` GraphQL
   * error (Linear's 400), or a `HeraError` with status 429.
   */
  readonly definitive?: ((error: E) => boolean) | undefined
}

function isRateLimited(error: unknown): boolean {
  if (RateLimitedError.is(error)) return true
  if (error instanceof HeraHttpError) {
    return error.graphqlErrors?.some((e) => e.code === "RATELIMITED") === true
  }
  return HeraError.is(error) && error.httpStatus === 429
}

/**
 * A create under a client-chosen id that never writes twice. When `create` fails with anything but
 * a definitive failure, the reply may only have been lost, so `find` reads the id back: an entity
 * this create owns answers `Found`; one it does not fails `HeraError` `conflict` (409); nothing
 * there re-raises the create's own error (fail closed). A failing `find` fails with its own error.
 */
export function createOnce<A, E, R, F, E2, R2>(
  options: HeraCreateOnceOptions<A, E, R, F, E2, R2>
): Effect.Effect<HeraCreateOnce<A, F>, E | E2 | HeraError, R | R2> {
  const definitive = options.definitive ?? isRateLimited
  const owns = options.owns ?? (() => true)
  return options.create.pipe(
    Effect.map((value): HeraCreateOnce<A, F> => ({ _tag: "Created", value })),
    Effect.catch((error: E) => {
      if (definitive(error)) return Effect.fail(error)
      return options.find.pipe(
        Effect.flatMap((found): Effect.Effect<HeraCreateOnce<A, F>, E | HeraError> => {
          if (found === null) return Effect.fail(error)
          if (!owns(found)) {
            return Effect.fail(
              new HeraError({ code: "conflict", httpStatus: 409, cause: error })
            )
          }
          return Effect.succeed({ _tag: "Found", value: found })
        })
      )
    })
  )
}
