import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { HeraAuthorityVerifier, refuseAuthority } from "../../../src/core/authority/index.js"
import { Hera } from "../../../src/index.js"
import { makeTestTenantCtx } from "../../../src/testing/index.js"

// An authority-guarded `Hera.authedRoute` on workerd. The credential rides in `x-grant`. The
// verifier grants `good`, refuses `stale` with its own slug, and refuses anything else with text
// that echoes the credential, so the test can check the boundary cuts it before the wire.
const verifier = HeraAuthorityVerifier.layer({
  verify: (request) => {
    const credential = Redacted.value(request.credential)
    if (credential === "good") return Effect.succeed({ id: `grant-for-${request.params.gate}` })
    if (credential === "stale") return Effect.fail(refuseAuthority("grant-expired", { what: "the grant expired" }))
    return Effect.fail(refuseAuthority("grant-unknown", { what: `no grant matches ${credential}` }))
  },
})

const skip = Hera.authedRoute({
  name: "Smoke.skip",
  service: "workerd-authority-smoke",
  method: "POST",
  path: "/skip/:gate",
  authority: {
    verb: "gate:skip",
    credential: ({ request }) => request.headers.get("x-grant") ?? undefined,
    params: ({ params }) => ({ gate: params.gate ?? "" }),
    verifier,
  },
  handler: (_ctx, authority) => Effect.succeed({ grant: authority.grant.id, verb: authority.verb }),
})

const routes = Hera.router([skip])
const tenant = makeTestTenantCtx()

export default {
  fetch(request: Request): Promise<Response> {
    return routes(request, { tenant })
  },
} satisfies ExportedHandler
