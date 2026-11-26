import * as Effect from "effect/Effect"
import { httpRpcClient } from "../../../src/server/rpc/index.js"

// The caller of the HTTP-over-RPC lane: forwards a POST with a JSON body, holds `waitUntil` past
// the callee's answer (as a slow trace export would), and reads the reply body.
interface Env {
  readonly API: {
    handle(input: unknown, meta?: unknown): Promise<unknown>
    rawHandle(request: Request): Promise<Response>
  }
}

function post(): Request {
  return new Request("https://api.test/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ probe: true, n: 7 }),
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, 300)))
    if (new URL(request.url).pathname === "/raw") {
      const raw = await env.API.rawHandle(post())
      return new Response(await raw.text(), { status: raw.status })
    }
    const api = httpRpcClient(env.API, { service: "http-api", propagate: true })
    // hera-allow: raw-effect-run
    const reply = await Effect.runPromise(api.fetch(post()))
    return new Response(await reply.text(), { status: reply.status, headers: { "x-api": reply.headers.get("x-api") ?? "" } })
  },
}
