import * as Effect from "effect/Effect"
import { Hera, HeraHttp } from "../../../src/index.js"

// `HeraHttp.sse` served through `Hera.publicRoute` on workerd. The source parks until the client goes
// away; `/status` reports whether the signal the writer handed the source aborted. The state is
// isolate-scoped on purpose: the test reads it from a second request to the same isolate.
const seen = { signalAborted: false, outcome: "open" }

const stream = Hera.publicRoute({
  name: "Smoke.sse",
  service: "workerd-sse-smoke",
  method: "GET",
  path: "/sse",
  handler: ({ request }) =>
    HeraHttp.sse(
      (signal) => {
        signal.addEventListener("abort", () => {
          seen.signalAborted = true
        })
        return (async function* () {
          yield { id: "c1", delta: "hello" }
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
        })()
      },
      {
        sentinel: "[DONE]",
        keepalive: { interval: 50, comment: "queued" },
        disconnect: request.signal,
        onEnd: (outcome) => {
          seen.outcome = outcome._tag
        },
      }
    ),
})

const status = Hera.publicRoute({
  name: "Smoke.status",
  service: "workerd-sse-smoke",
  method: "GET",
  path: "/status",
  handler: () => Effect.sync(() => ({ ...seen })),
})

const routes = Hera.router([stream, status])

export default {
  fetch(request: Request): Promise<Response> {
    return routes(request)
  },
} satisfies ExportedHandler
