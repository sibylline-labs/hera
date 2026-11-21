import * as Effect from "effect/Effect"
import { Hera } from "../../../src/index.js"

// A WebSocket upgrade served through `Hera.publicRoute`: the boundary must hand the 101 `Response`
// (with its `webSocket`) to the runtime untouched.
const upgrade = Hera.publicRoute({
  name: "Smoke.upgrade",
  service: "workerd-upgrade-smoke",
  method: "GET",
  path: "/ws",
  handler: () =>
    Effect.sync(() => {
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      server.accept()
      server.send("ready")
      server.addEventListener("message", (event) => {
        server.send(`echo:${String(event.data)}`)
      })
      return new Response(null, { status: 101, webSocket: client })
    }),
})

const plain = Hera.publicRoute({
  name: "Smoke.plain",
  service: "workerd-upgrade-smoke",
  method: "GET",
  path: "/plain",
  handler: () => Effect.succeed({ hello: "world" }),
})

const routes = Hera.router([upgrade, plain])

export default {
  fetch(request: Request): Promise<Response> {
    return routes(request)
  },
} satisfies ExportedHandler
