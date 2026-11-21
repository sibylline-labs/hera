import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { HeraError } from "../../../src/core/errors/index.js"
import { createHeraLogger } from "../../../src/core/logger/index.js"
import { HeraTelemetry } from "../../../src/core/telemetry/index.js"
import { publicRoute } from "../../../src/server/routes/index.js"
import { worker } from "../../../src/server/worker/index.js"

// One isolate's telemetry, unsampled at the head (random 0.5 > 1%), posting to a capture host.
const telemetry = HeraTelemetry.make({
  service: "workerd-telemetry",
  environment: "test",
  sink: { baseUrl: "https://logfire.test", token: Redacted.make("write-token") },
  random: () => 0.5,
})
const logger = createHeraLogger({ service: "workerd-telemetry" })
// Assembled at run time so the source holds no secret-shaped literal.
const SECRET = "ghp" + "_" + "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xYz123"

const work = (extra: Effect.Effect<unknown, unknown>) =>
  logger.info("step.one").pipe(
    Effect.andThen(Effect.void.pipe(Effect.withSpan("inner"))),
    Effect.andThen(extra),
    Effect.as({ ok: true })
  )

const ROUTES: Record<string, Effect.Effect<unknown, unknown>> = {
  "/healthy": Effect.void,
  "/warn": logger.warn("routine.warn"),
  "/error": logger.error("broke"),
  "/slow": Effect.sleep("1100 millis"),
  "/5xx": Effect.fail(new HeraError({ code: "internal_unavailable", httpStatus: 503, publicMessage: "down", requestId: "req_x" as never })),
  "/die": Effect.sync(() => {
    throw new TypeError(`raw ${SECRET}`)
  }),
}

export default worker(
  {
    async fetch(request: Request, _env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
      const path = new URL(request.url).pathname
      if (path === "/throw") throw new Error(`thrown ${SECRET}`)
      if (path === "/wait-reject") {
        ctx.waitUntil(Promise.reject(new RangeError(`late ${SECRET}`)))
        return new Response("ok")
      }
      const extra = ROUTES[path]
      if (extra === undefined) return new Response("nope", { status: 404 })
      const route = publicRoute({ method: "GET", path, service: "workerd-telemetry", handler: () => work(extra) })
      return route(request, { telemetry: { telemetry, waitUntil: (p) => ctx.waitUntil(p) } })
    },
  },
  { service: "workerd-telemetry" }
)
