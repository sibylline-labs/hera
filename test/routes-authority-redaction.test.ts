import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import { HeraAuthorityVerifier, refuseAuthority } from "../src/core/authority/index.js"
import { Hera, type HeraBoundaryDefectLog, HeraError } from "../src/index.js"
import { makeTestTenantCtx } from "../src/testing/index.js"

const tenant = makeTestTenantCtx()

interface Outcome {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly raw: string
  readonly defects: ReadonlyArray<HeraBoundaryDefectLog>
  readonly handlerCalls: number
}

/** One guarded request whose credential reader answers `credential`, against `verifier`. */
async function guarded(
  credential: string,
  verifier: Layer.Layer<HeraAuthorityVerifier, HeraError>,
  reader?: () => string
): Promise<Outcome> {
  let handlerCalls = 0
  const route = Hera.authedRoute({
    name: "Gates.skip",
    method: "POST",
    authority: {
      verb: "gate:skip",
      credential: reader ?? (() => credential),
      verifier,
    },
    handler: () => Effect.sync(() => ++handlerCalls),
  })
  const defects: HeraBoundaryDefectLog[] = []
  const res = await route(new Request("http://t/", { method: "POST" }), {
    tenant,
    onDefect: (entry) => void defects.push(entry),
  })
  const raw = await res.text()
  return { status: res.status, body: JSON.parse(raw) as Record<string, unknown>, raw, defects, handlerCalls }
}

function failsBuilding(err: HeraError): Layer.Layer<HeraAuthorityVerifier, HeraError> {
  return Layer.effect(HeraAuthorityVerifier, Effect.fail(err))
}

function expectAbsent(outcome: Outcome, ...values: ReadonlyArray<string>): void {
  for (const value of values) {
    expect(outcome.raw).not.toContain(value)
    expect(JSON.stringify(outcome.defects)).not.toContain(value)
  }
  expect(outcome.handlerCalls).toBe(0)
}

describe("authority route redaction edge cases", () => {
  // admits: algorithmic — a credential with JSON-escaped characters must still be matched exactly
  // in string fields, nested values and keys; a JSON round trip matches only its escaped form.
  it("redacts a credential holding quotes, backslashes and newlines from nested fields and keys", async () => {
    const cred = 'cred"with\\quote\nsecret_999'
    const out = await guarded(
      cred,
      failsBuilding(
        HeraError.badGateway("verifier down", { fields: { detail: `saw ${cred}`, nested: { list: [`x ${cred}`], [`k${cred}`]: 1 } } })
      )
    )
    expect(out.status).toBe(502)
    expect(out.body).toMatchObject({ fields: { detail: "saw [REDACTED]", nested: { list: ["x [REDACTED]"] } } })
    expectAbsent(out, cred, JSON.stringify(cred).slice(1, -1))
  })

  // admits: algorithmic — field values a JSON round trip cannot carry (a cycle, a bigint) or a
  // credential that rewrites JSON structure (`true`, `"`) must not throw past the error mapping.
  it.each([["true"], ['"'], ["]"]])("maps odd field values without throwing for credential %j", async (cred) => {
    const cyclic: Record<string, unknown> = { flag: true, list: [1, 2] }
    cyclic.self = cyclic
    const out = await guarded(cred, failsBuilding(HeraError.badGateway("down", { fields: { cyclic, big: BigInt(7) as unknown } })))
    expect(out.status).toBe(502)
    expect(out.defects).toEqual([])
    expect(out.handlerCalls).toBe(0)
  })

  // admits: algorithmic — a layer error whose code carries the credential cannot render that code.
  it("replaces a layer error code that carries the credential", async () => {
    const cred = "opaque_code_secret_1234"
    const out = await guarded(cred, failsBuilding(new HeraError({ code: `${cred}_unavailable` as never, httpStatus: 503 })))
    expect(out.status).toBe(503)
    expect(out.body).toMatchObject({ code: "service_unavailable", slug: "authority-verifier-unavailable", retryable: true })
    expectAbsent(out, cred)
  })

  // admits: algorithmic — an upstream credential the verifier echoes (not the caller's) is caught
  // by the shape scrub that runs after the exact match.
  it("scrubs credential-shaped upstream tokens from a refusal", async () => {
    const upstream = "ghp_" + "a".repeat(36)
    const bearer = "Bearer sib_live_upstreamTokenValue"
    const verifier = HeraAuthorityVerifier.layer({
      verify: () => Effect.fail(refuseAuthority("grant-unknown", { what: `upstream said ${upstream}`, fix: bearer })),
    })
    const out = await guarded("caller-credential", verifier)
    expect(out.status).toBe(403)
    expect(out.body.slug).toBe("grant-unknown")
    expectAbsent(out, upstream, "sib_live_upstreamTokenValue")
  })

  // admits: algorithmic — a failure outside the catalogue is the typed retryable 503, not a defect.
  it("maps an uncatalogued verifier failure to the retryable 503", async () => {
    const cred = "opaque_uncatalogued_77"
    const verifier = HeraAuthorityVerifier.layer({ verify: () => Effect.fail({ _tag: cred } as never) })
    const out = await guarded(cred, verifier)
    expect(out.status).toBe(503)
    expect(out.body).toMatchObject({ slug: "authority-verifier-unavailable", retryable: true })
    expectAbsent(out, cred)
  })

  // admits: algorithmic — a throwing credential reader dies with the fixed defect, not its value.
  it("replaces a throw in the credential reader with the fixed defect", async () => {
    const cred = "opaque_reader_secret_88"
    const out = await guarded(cred, HeraAuthorityVerifier.layer({ verify: () => Effect.succeed({ id: "g" }) }), () => {
      throw { _tag: cred, message: cred }
    })
    expect(out.status).toBe(503)
    expect(out.defects.map((d) => d.defect_name)).toEqual(["HeraAuthorityVerifierDefect"])
    expectAbsent(out, cred)
  })
})
