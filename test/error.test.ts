import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  HERA_ERROR_CATALOG,
  HeraConfig,
  HeraError,
  type HeraErrorCode,
  type HeraErrorStatus,
  HeraSchema,
  isHeraErrorStatus,
  OrgId,
} from "../src/index"
import { SAMPLE_IDS } from "../src/testing/index"

describe("HeraError — closed error catalog, HeraError.define, and toResponse", () => {
  it("enforces a closed compile-time union for HeraErrorCode and HeraErrorStatus", () => {
    const validCatalogCode: HeraErrorCode = "invalid_request"
    const validTemplateUnconf: HeraErrorCode = "turnkey_api_key_unconfigured"
    const validTemplateInvalid: HeraErrorCode = "turnkey_api_key_invalid_config"
    const validTemplateUnavail: HeraErrorCode = "relay_unavailable"
    const validStatus: HeraErrorStatus = 429

    // @ts-expect-error uncatalogued arbitrary string must not be assignable to HeraErrorCode
    const _invalidCode: HeraErrorCode = "totally_made_up_code"

    // @ts-expect-error arbitrary status outside HeraErrorStatus must not compile
    const _invalidStatus: HeraErrorStatus = 418

    expect(validCatalogCode).toBe("invalid_request")
    expect(validTemplateUnconf).toBe("turnkey_api_key_unconfigured")
    expect(validTemplateInvalid).toBe("turnkey_api_key_invalid_config")
    expect(validTemplateUnavail).toBe("relay_unavailable")
    expect(validStatus).toBe(429)
    expect(_invalidCode).toBe("totally_made_up_code")
    expect(_invalidStatus).toBe(418)
  })

  // admits: 412 missing from the runtime HERA_ERROR_STATUSES list (registry and RPC rehydration read it); a type cannot tie the list to the union
  it("412 precondition_failed is a closed status and catalog code", () => {
    const status: HeraErrorStatus = 412
    const err = HeraError.preconditionFailed()
    expect(status).toBe(412)
    expect(isHeraErrorStatus(412)).toBe(true)
    expect(err.code).toBe("precondition_failed")
    expect(err.httpStatus).toBe(412)
    expect(err.toProblemDetails()).toMatchObject({
      status: 412,
      code: "precondition_failed",
      title: "Precondition failed",
    })
  })

  it("defines domain errors via HeraError.define built on Schema.TaggedError with yield* semantics", async () => {
    const QuotaExceededError = HeraError.define("QuotaExceededError", {
      code: "quota_exceeded",
      publicMessage: "Organization monthly quota exceeded",
      fields: {
        orgId: OrgId,
        limit: Schema.Number,
        used: Schema.Number,
      },
    })

    // @ts-expect-error HeraError.define rejects uncatalogued error codes at compile time
    HeraError.define("InvalidCodeError", { code: "not_in_hera_catalog" })

    expect(QuotaExceededError._tag).toBe("QuotaExceededError")
    expect(QuotaExceededError.code).toBe("quota_exceeded")
    expect(QuotaExceededError.status).toBe(429)
    expect(QuotaExceededError.httpStatus).toBe(429)
    expect(QuotaExceededError.publicMessage).toBe(
      "Organization monthly quota exceeded"
    )

    const instance = new QuotaExceededError({
      orgId: SAMPLE_IDS.orgId,
      limit: 1000,
      used: 1001,
    })

    expect(QuotaExceededError.is(instance)).toBe(true)
    expect(HeraError.isDefinedError(instance)).toBe(true)
    expect(HeraError.isAny(instance)).toBe(true)
    expect(instance._tag).toBe("QuotaExceededError")
    expect(instance.code).toBe("quota_exceeded")
    expect(instance.status).toBe(429)
    expect(instance.orgId).toBe(SAMPLE_IDS.orgId)
    expect(instance.limit).toBe(1000)
    expect(instance.used).toBe(1001)

    // Yieldable directly inside Effect.gen without Effect.fail wrapper
    const program = Effect.gen(function* () {
      return yield* instance
    })

    const exit = await Effect.runPromiseExit(program)
    expect(exit._tag).toBe("Failure")

    const response = instance.toResponse({ requestId: SAMPLE_IDS.requestId })
    expect(response.status).toBe(429)
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json; charset=utf-8"
    )
    expect(response.headers.get("x-request-id")).toBe(SAMPLE_IDS.requestId)

    const body = (await response.json()) as Record<string, unknown>
    expect(body).toEqual({
      type: "urn:hera:error:quota_exceeded",
      title: HERA_ERROR_CATALOG.quota_exceeded.publicMessage,
      status: 429,
      detail: "Organization monthly quota exceeded",
      code: "quota_exceeded",
      request_id: SAMPLE_IDS.requestId,
      orgId: SAMPLE_IDS.orgId,
      limit: 1000,
      used: 1001,
      fields: {
        orgId: SAMPLE_IDS.orgId,
        limit: 1000,
        used: 1001,
      },
    })
  })

  it("redacts Redacted<T>, Error instances, and sensitive field keys in defined error fields", async () => {
    const UpstreamError = HeraError.define("UpstreamError", {
      code: "upstream_unavailable",
      fields: {
        upstream: Schema.String,
        apiKey: Schema.Any,
      },
    })

    const rawSecret = "sk_live_top_secret_value_999"
    const err = new UpstreamError({
      upstream: "turnkey",
      apiKey: Redacted.make(rawSecret),
    })

    const res = HeraError.toResponse(err, { requestId: SAMPLE_IDS.requestId })
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).not.toContain(rawSecret)
    const parsed = JSON.parse(text) as { fields: Record<string, unknown> }
    expect(parsed.fields.upstream).toBe("turnkey")
    expect(parsed.fields.apiKey).toBe("[REDACTED]")
  })

  it("serializes HeraError, HeraDefinedError, HeraSchemaError, HeraConfigError, and unknown defects safely via HeraError.toResponse", async () => {
    // 1. Rate-limited HeraError with retryAfter header
    const rateErr = HeraError.rateLimited("Slow down", {
      retryAfter: 30,
      requestId: SAMPLE_IDS.requestId,
    })
    const rateRes = HeraError.toResponse(rateErr)
    expect(rateRes.status).toBe(429)
    expect(rateRes.headers.get("retry-after")).toBe("30")
    expect(rateRes.headers.get("x-request-id")).toBe(SAMPLE_IDS.requestId)
    const rateBody = (await rateRes.json()) as Record<string, unknown>
    expect(rateBody.code).toBe("rate_limited")
    expect(rateBody.retry_after).toBe(30)

    // 2. HeraConfigError (unconfigured & invalid)
    const secretReader = HeraConfig.hexKey("SIGNING_SECRET", 32)
    const unconfFlip = await Effect.runPromise(
      Effect.flip(secretReader.effect({}))
    )
    const unconfRes = HeraError.toResponse(unconfFlip)
    expect(unconfRes.status).toBe(503)
    const unconfBody = (await unconfRes.json()) as Record<string, unknown>
    expect(unconfBody.code).toBe("signing_secret_unconfigured")

    const leakedSecret = "bad-secret-value-never-echo-me-12345"
    const invalidFlip = await Effect.runPromise(
      Effect.flip(secretReader.effect({ SIGNING_SECRET: leakedSecret }))
    )
    const invalidRes = HeraError.toResponse(invalidFlip)
    expect(invalidRes.status).toBe(503)
    const invalidText = await invalidRes.text()
    expect(invalidText).not.toContain(leakedSecret)
    expect(JSON.parse(invalidText).code).toBe("signing_secret_invalid_config")

    // 3. HeraSchemaError
    const BadInput = Schema.Struct({ orgId: OrgId })
    const badCandidate = "malformed_org_secret_token_777"
    const decRes = HeraSchema.decodeResult(BadInput, { orgId: badCandidate })
    expect(decRes._tag).toBe("Failure")
    if (decRes._tag === "Failure") {
      const schemaRes = HeraError.toResponse(decRes.failure)
      expect(schemaRes.status).toBe(400)
      const schemaText = await schemaRes.text()
      expect(schemaText).not.toContain(badCandidate)
      const schemaBody = JSON.parse(schemaText) as Record<string, unknown>
      expect(schemaBody.code).toBe("invalid_request")
      expect(Array.isArray(schemaBody.issues)).toBe(true)
    }

    // 4. Raw thrown Error / defect never leaks its message
    const rawDefect = new Error(
      "SELECT * FROM users WHERE password_hash = 'secret_hash_leak'"
    )
    const defectRes = HeraError.toResponse(rawDefect, {
      requestId: SAMPLE_IDS.requestId,
    })
    expect(defectRes.status).toBe(503)
    const defectText = await defectRes.text()
    expect(defectText).not.toContain("password_hash")
    expect(defectText).not.toContain("secret_hash_leak")
    const defectBody = JSON.parse(defectText) as Record<string, unknown>
    expect(defectBody.code).toBe("internal_unavailable")
    expect(defectBody.status).toBe(503)
    expect(defectBody.detail).toBe(
      HERA_ERROR_CATALOG.internal_unavailable.publicMessage
    )
  })
})
