import { WorkerEntrypoint } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { router, publicRoute } from "../../../src/server/routes/index.js"
import {
  type HeraRpcInvokeMeta,
  type HeraRpcResult,
  type HttpRpcReply,
  type HttpRpcRequest,
  httpRpcMethod,
} from "../../../src/server/rpc/index.js"

// The callee of the HTTP-over-RPC lane: `handle` forwards through `httpRpcMethod` over a router;
// `rawHandle` takes a raw `Request` and never reads its body, the shape cloudflare/workerd#8674 cancels.
const api = router([
  publicRoute({
    method: "POST",
    path: "/echo",
    service: "http-api",
    handler: ({ request }) =>
      Effect.promise(async () => {
        const body = (await request.json()) as Record<string, unknown>
        return Response.json({ echoed: body, method: request.method }, { status: 201, headers: { "x-api": "1" } })
      }),
  }),
])

const handleMethod = httpRpcMethod("handle", { service: "http-api", router: api })

export class HttpApi extends WorkerEntrypoint {
  handle(input: HttpRpcRequest, meta?: HeraRpcInvokeMeta): Promise<HeraRpcResult<HttpRpcReply>> {
    return handleMethod(input, meta)
  }

  async rawHandle(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ raw: true }), { status: 200 })
  }
}

export default {
  fetch(): Response {
    return new Response(null, { status: 404 })
  },
}
