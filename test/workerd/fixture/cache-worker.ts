import * as Effect from "effect/Effect"
import { HeraCache } from "../../../src/index.js"

// One HeraCache per isolate, as a Worker holds a reader across requests. `/get?key=` reads the key
// through it; the lookup fetches `https://lookup.test/<key>`, which the test's outbound service
// answers. With `?then=1` the same fiber then fetches `https://after.test/<key>` before it answers, as
// a route does more I/O after reading a dial.
const lookup = (key: string) =>
  Effect.promise(async () => (await fetch(`https://lookup.test/${key}`)).text())

const cache = HeraCache.make({ ttlMs: 60_000, lookup })

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const key = url.searchParams.get("key") ?? ""
    const after = Effect.promise(async () => (await fetch(`https://after.test/${key}`)).text())
    const value = await Effect.runPromise(
      url.searchParams.get("then") === "1" ? Effect.tap(cache.get(key), () => after) : cache.get(key),
    )
    return Response.json({ value })
  },
} satisfies ExportedHandler
