import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import {
  ActorId,
  CIRCULAR_VALUE,
  createHeraLogger,
  HeraError,
  HeraLoggerService,
  type LogEntry,
  OrgId,
  REDACTED_VALUE,
  RequestId,
  scrubLogMetadata,
  scrubLogValue,
  TRUNCATED_VALUE,
} from "../src/index"

const ULID_LOG = "01JAW4B8X7H2M9Q5R8T3V6Y1Z0"
const REQ_LOG_1 = RequestId.make(`req_${ULID_LOG}`)
const ORG_LOG_1 = OrgId.make(`org_${ULID_LOG}`)
const ACT_LOG_1 = ActorId.make(`act_${ULID_LOG}`)

describe("HeraLogger", () => {
  it("emits single-line structured JSON with correlation fields and protects reserved keys", async () => {
    const lines: Array<string> = []
    const entries: Array<LogEntry> = []

    const logger = createHeraLogger({
      service: "hera-gateway",
      requestId: REQ_LOG_1,
      orgId: ORG_LOG_1,
      actorId: ACT_LOG_1,
      sink: (line, entry) => {
        lines.push(line)
        entries.push(entry)
      },
    })

    const program = Effect.gen(function* () {
      yield* logger.info("request handled", {
        status: 200,
        durationMs: 14,
        // Attempt to spoof reserved fields via untrusted metadata:
        org_id: "org_spoofed",
        actor_id: "act_spoofed",
        level: "error",
        service: "spoofed-service",
      })
    }).pipe(Effect.withSpan("http.post.items"))

    await Effect.runPromise(program)

    expect(lines).toHaveLength(1)
    const rawLine = lines[0]!
    expect(rawLine.includes("\n")).toBe(false)

    const parsed = JSON.parse(rawLine) as LogEntry
    expect(parsed.level).toBe("info")
    expect(parsed.service).toBe("hera-gateway")
    expect(parsed.msg).toBe("request handled")
    expect(parsed.request_id).toBe(REQ_LOG_1)
    expect(parsed.org_id).toBe(ORG_LOG_1)
    expect(parsed.actor_id).toBe(ACT_LOG_1)
    expect(parsed.span).toBe("http.post.items")
    expect(parsed.status).toBe(200)
    expect(parsed.durationMs).toBe(14)
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow()
  })

  it("scrubs Error and HeraError instances, removing raw messages and stack traces unless code is whitelisted", async () => {
    const lines: Array<string> = []
    const entries: Array<LogEntry> = []

    const logger = createHeraLogger({
      service: "hera-worker",
      sink: (line, entry) => {
        lines.push(line)
        entries.push(entry)
      },
    })

    const rawDbError = new Error("db password is xyz")
    const infraError = HeraError.internal("token=secret_infra_value")

    await Effect.runPromise(
      logger.error("operation failed", {
        dbErr: rawDbError,
        infraErr: infraError,
      })
    )

    expect(lines).toHaveLength(1)
    const serialized = lines[0]!
    expect(serialized).not.toContain("db password is xyz")
    expect(serialized).not.toContain("xyz")
    expect(serialized).not.toContain("token=secret_infra_value")
    expect(serialized).not.toContain("secret_infra_value")
    expect(serialized).not.toContain("stack")

    const entry = entries[0]!
    expect(entry.dbErr).toEqual({
      name: "Error",
      code: "unclassified_error",
      message: REDACTED_VALUE,
    })
    expect(entry.infraErr).toEqual({
      _tag: "HeraError",
      name: "HeraError",
      code: "internal_error",
      message: REDACTED_VALUE,
      status: 500,
    })

    // Verify explicit HeraError code whitelisting preserves safe message while still stripping stack & scrubbing tokens
    const whitelistedEntries: Array<LogEntry> = []
    const whitelistedLogger = createHeraLogger({
      service: "hera-worker",
      whitelistedErrorCodes: ["unauthorized"],
      sink: (_line, e) => {
        whitelistedEntries.push(e)
      },
    })

    const safeAuthError = HeraError.unauthorized("missing required scope yak:write")
    const leakyAuthError = HeraError.unauthorized("Bearer secret_jwt_value rejected")

    await Effect.runPromise(
      whitelistedLogger.warn("auth rejected", {
        safe: safeAuthError,
        leaky: leakyAuthError,
      })
    )

    expect(whitelistedEntries[0]?.safe).toEqual({
      _tag: "HeraError",
      name: "HeraError",
      code: "unauthorized",
      message: "missing required scope yak:write",
      status: 401,
    })
    // The credential run is replaced in place; the rest of the message stays readable.
    expect(whitelistedEntries[0]?.leaky).toEqual({
      _tag: "HeraError",
      name: "HeraError",
      code: "unauthorized",
      message: `${REDACTED_VALUE} rejected`,
      status: 401,
    })
    expect(JSON.stringify(whitelistedEntries[0])).not.toContain("secret_jwt_value")
  })

  it("auto-redacts credential-shaped keys and Redacted<T> values at any nesting depth", async () => {
    const lines: Array<string> = []
    const entries: Array<LogEntry> = []

    const logger = createHeraLogger({
      service: "hera-auth",
      sink: (line, entry) => {
        lines.push(line)
        entries.push(entry)
      },
    })

    await Effect.runPromise(
      logger.info("inspecting request metadata", {
        authorization: "Basic dXNlcjpwYXNz",
        api_key: "raw_api_key_value",
        secret: "top_secret_value",
        token: "session_token_value",
        key_hash: "sha256_hash_value",
        nested: {
          redactedVal: Redacted.make("super_secret_redacted_string"),
          arrayItems: [
            "safe_item",
            Redacted.make("nested_array_secret"),
            { clientSecret: "oauth_client_secret_val" },
          ],
        },
      })
    )

    const raw = lines[0]!
    expect(raw).not.toContain("dXNlcjpwYXNz")
    expect(raw).not.toContain("raw_api_key_value")
    expect(raw).not.toContain("top_secret_value")
    expect(raw).not.toContain("session_token_value")
    expect(raw).not.toContain("sha256_hash_value")
    expect(raw).not.toContain("super_secret_redacted_string")
    expect(raw).not.toContain("nested_array_secret")
    expect(raw).not.toContain("oauth_client_secret_val")

    const entry = entries[0]!
    expect(entry.authorization).toBe(REDACTED_VALUE)
    expect(entry.api_key).toBe(REDACTED_VALUE)
    expect(entry.secret).toBe(REDACTED_VALUE)
    expect(entry.token).toBe(REDACTED_VALUE)
    expect(entry.key_hash).toBe(REDACTED_VALUE)
    expect(entry.nested).toEqual({
      redactedVal: REDACTED_VALUE,
      arrayItems: [
        "safe_item",
        REDACTED_VALUE,
        { clientSecret: REDACTED_VALUE },
      ],
    })
  })

  it("property test (fast-check): arbitrary nested structures with Redacted, Error, and bearer/API keys never leak secrets", () => {
    const safeKeyArb = fc.constantFrom("alpha", "beta", "gamma", "payload", "items", "meta", "detail")
    const secretKeyArb = fc.constantFrom(
      "authorization",
      "api_key",
      "secret",
      "token",
      "key_hash",
      "client_secret",
      "access_token"
    )
    const secretCoreArb = fc
      .stringMatching(/^[A-Za-z0-9]{10,28}$/)
      .map((s) => `SEC_${s}_END`)

    fc.assert(
      fc.property(
        secretCoreArb,
        safeKeyArb,
        secretKeyArb,
        (secretCore, safeKey, secretKey) => {
          const lines: Array<string> = []
          const logger = createHeraLogger({
            service: "hera-prop-test",
            sink: (line) => {
              lines.push(line)
            },
          })

          const metadata: Record<string, unknown> = {
            [safeKey]: {
              redactedLeaf: Redacted.make(secretCore),
              errorLeaf: new Error(`failed with ${secretCore}`),
              heraErrorLeaf: HeraError.internal(`upstream ${secretCore}`),
              bearerLeaf: `Bearer ${secretCore}`,
              olLiveLeaf: `ol_live_${secretCore}`,
              sibLiveLeaf: `sib_live_${secretCore}`,
              deepArray: [
                {
                  [secretKey]: secretCore,
                  innerList: [
                    Redacted.make(secretCore),
                    `ol_test_${secretCore}`,
                    `sib_test_${secretCore}`,
                  ],
                },
              ],
            },
          }

          Effect.runSync(logger.info("property check", metadata))

          expect(lines).toHaveLength(1)
          const serialized = lines[0]!
          expect(serialized).not.toContain(secretCore)
          expect(serialized).not.toContain(`Bearer ${secretCore}`)
          expect(serialized).not.toContain(`ol_live_${secretCore}`)
          expect(serialized).not.toContain(`sib_live_${secretCore}`)
        }
      ),
      { numRuns: 100 }
    )
  })

  it("binds child logger correlation metadata both directly and across an Effect fiber scope via Layer", async () => {
    const entries: Array<LogEntry> = []
    const rootLogger = createHeraLogger({
      service: "hera-jobs",
      requestId: REQ_LOG_1,
      orgId: ORG_LOG_1,
      sink: (_line, entry) => {
        entries.push(entry)
      },
    })

    const childLogger = rootLogger.child({ jobId: "job_1", attempt: 2 })

    // 1. Direct child logger invocation
    await Effect.runPromise(childLogger.info("direct child log", { step: "init" }))

    // 2. Fiber-scoped Layer propagation: even calling rootLogger or HeraLoggerService inside the layer scope carries jobId & attempt
    const scopedProgram = Effect.gen(function* () {
      const ambientLogger = yield* HeraLoggerService
      yield* ambientLogger.info("from HeraLoggerService in fiber scope")
      yield* rootLogger.info("from rootLogger inside child layer scope")
    }).pipe(Effect.provide(childLogger.layer))

    await Effect.runPromise(scopedProgram)

    // 3. Outside the fiber scope, rootLogger does not have jobId
    await Effect.runPromise(rootLogger.info("outside child scope"))

    expect(entries).toHaveLength(4)
    expect(entries[0]).toMatchObject({
      msg: "direct child log",
      request_id: REQ_LOG_1,
      org_id: ORG_LOG_1,
      jobId: "job_1",
      attempt: 2,
      step: "init",
    })
    expect(entries[1]).toMatchObject({
      msg: "from HeraLoggerService in fiber scope",
      jobId: "job_1",
      attempt: 2,
    })
    expect(entries[2]).toMatchObject({
      msg: "from rootLogger inside child layer scope",
      jobId: "job_1",
      attempt: 2,
    })
    expect(entries[3]?.msg).toBe("outside child scope")
    expect(entries[3]?.jobId).toBeUndefined()
  })

  it("handles circular references, deep nesting, and default console sink safely without throwing", async () => {
    const circular: Record<string, unknown> = { name: "loop" }
    circular.self = circular

    const scrubbedCircular = scrubLogValue(circular) as Record<string, unknown>
    expect(scrubbedCircular.name).toBe("loop")
    expect(scrubbedCircular.self).toBe(CIRCULAR_VALUE)

    const scrubbedMeta = scrubLogMetadata({
      api_key: "secret_key",
      safeField: "ok",
    })
    expect(scrubbedMeta).toEqual({
      api_key: REDACTED_VALUE,
      safeField: "ok",
    })

    let deep: Record<string, unknown> = { leaf: "bottom" }
    for (let i = 0; i < 12; i++) {
      deep = { child: deep }
    }
    const serializedDeep = JSON.stringify(scrubLogValue(deep))
    expect(serializedDeep).toContain(TRUNCATED_VALUE)

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const consoleLogger = createHeraLogger({ service: "hera-console" })
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* consoleLogger.debug("debug line")
          yield* consoleLogger.info("info line")
          yield* consoleLogger.warn("warn line")
          yield* consoleLogger.error("error line")
        })
      )
      expect(logSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})
