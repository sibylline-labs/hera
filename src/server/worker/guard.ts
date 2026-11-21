import { HeraError } from "../../core/errors/index.js"
import { GITLEAKS_SHAPES } from "../../core/logger/gitleaks.js"
import { createHeraLogger } from "../../core/logger/logger.js"
import type { LogSink } from "../../core/logger/types.js"
import { resolveRequestId } from "../routes/headers.js"
import { safeDefectFields, sanitizeDefect } from "./defect.js"

/** The `ExecutionContext` surface the guard wraps. */
export interface HeraWorkerContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

/** A Worker's exported handler, as far as the guard reads it. Other members pass through untouched. */
export interface HeraWorkerHandler<Env, Ctx extends HeraWorkerContext = HeraWorkerContext> {
  fetch?(request: Request, env: Env, ctx: Ctx): Response | Promise<Response>
  queue?(batch: never, env: Env, ctx: Ctx): void | Promise<void>
  scheduled?(controller: never, env: Env, ctx: Ctx): void | Promise<void>
}

export interface HeraWorkerOptions {
  readonly service: string
  /** Where the guard's own lines go; default the console (the runtime's log backstop). */
  readonly sink?: LogSink | undefined
}

const EVENTS = ["hera.worker.defect", "hera.worker.wait_until_rejected"] as const

/**
 * Guards a Worker's exported handler so no raw exception text reaches the runtime. A `fetch`
 * that throws answers `503 internal_unavailable` problem+json; a `queue` or `scheduled` handler
 * that throws is logged and rethrown as a fixed-message `HeraBoundaryDefect` (the runtime still
 * retries); a promise handed to `ctx.waitUntil` that rejects is caught and logged. Every line
 * carries only the defect's class name and its scrubbed-stack fingerprint.
 */
export function worker<Env, H extends HeraWorkerHandler<Env>>(handler: H, options: HeraWorkerOptions): H {
  const logger = createHeraLogger({ service: options.service, events: EVENTS, sink: options.sink, secretShapes: GITLEAKS_SHAPES })
  const guardCtx = <C extends HeraWorkerContext>(ctx: C, entrypoint: string): C =>
    Object.assign(Object.create(ctx) as C, {
      waitUntil: (promise: Promise<unknown>) =>
        ctx.waitUntil(
          Promise.resolve(promise).catch((defect: unknown) =>
            logger.sync.error("hera.worker.wait_until_rejected", { entrypoint, ...safeDefectFields(defect) })
          )
        ),
    })
  const rethrowing = (entrypoint: "queue" | "scheduled") => {
    const inner = handler[entrypoint] as ((input: unknown, env: Env, ctx: HeraWorkerContext) => unknown) | undefined
    if (inner === undefined) return {}
    return {
      async [entrypoint](input: unknown, env: Env, ctx: HeraWorkerContext) {
        try {
          await inner.call(handler, input, env, guardCtx(ctx, entrypoint))
        } catch (defect) {
          logger.sync.error("hera.worker.defect", { entrypoint, ...safeDefectFields(defect) })
          throw sanitizeDefect(defect)
        }
      },
    }
  }
  const fetch = handler.fetch
  return Object.assign(Object.create(handler) as H, {
    ...(fetch === undefined
      ? {}
      : {
          async fetch(request: Request, env: Env, ctx: HeraWorkerContext): Promise<Response> {
            try {
              return await fetch.call(handler, request, env, guardCtx(ctx, "fetch") as never)
            } catch (defect) {
              const requestId = resolveRequestId(request)
              logger.sync.error("hera.worker.defect", { entrypoint: "fetch", requestId, ...safeDefectFields(defect) })
              return HeraError.toResponse(
                new HeraError({ code: "internal_unavailable", httpStatus: 503, publicMessage: "Internal service unavailable", requestId })
              )
            }
          },
        }),
    ...rethrowing("queue"),
    ...rethrowing("scheduled"),
  })
}
