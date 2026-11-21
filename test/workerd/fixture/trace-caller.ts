import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { HeraCtx } from "../../../src/core/context/index.js"
import { OrgId, RequestId } from "../../../src/core/schema/index.js"
import { rpcClient } from "../../../src/server/rpc/index.js"
import type { Callee } from "./trace-callee.js"

// The caller Worker of the trace-propagation lane.
interface Env {
  readonly CALLEE: Service<Callee>
}

const CALLER_REQUEST_ID = "req_01JAW4B8X7H2M9Q5R8T3V6Y1Z0"
const CALLER_ORG_ID = "org_01JAW4B8X7H2M9Q5R8T3V6Y1Z0"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/consumed") {
      return Response.json(await env.CALLEE.consumed())
    }
    const callee = rpcClient(env.CALLEE as unknown as { record(input: unknown): Promise<unknown> }, {
      service: "callee",
      propagate: true,
    })
    const program = Effect.gen(function* () {
      const span = yield* Effect.orDie(Effect.currentSpan)
      const result = yield* callee.record({ n: 1 })
      return { traceId: span.traceId, spanId: span.spanId, callee: result }
    }).pipe(
      Effect.withSpan("caller.request"),
      Effect.provide(
        HeraCtx.layer({
          requestId: RequestId.make(CALLER_REQUEST_ID),
          orgId: Option.some(OrgId.make(CALLER_ORG_ID)),
          actorId: Option.none(),
          service: "caller",
        })
      )
    )
    // hera-allow: raw-effect-run
    return Response.json(await Effect.runPromise(program))
  },
}
