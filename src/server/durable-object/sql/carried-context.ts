import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Tracer from "effect/Tracer"
import {
  HeraAuthedCtx,
  HeraCtx,
  HeraPublicCtx,
  HeraTenantCtx,
} from "../../../core/context/index.js"

/**
 * The part of the calling fiber a detached transaction body may see: its span and its Hera ctx,
 * nothing else. An outbox write in the body then records the trace and request it was made under.
 */
export const captureTxContext: Effect.Effect<Context.Context<never>> = Effect.withFiber((fiber) =>
  Effect.succeed(
    Context.pick(Tracer.ParentSpan, HeraCtx, HeraTenantCtx, HeraAuthedCtx, HeraPublicCtx)(
      fiber.context
    ) as Context.Context<never>
  )
)
