import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  Hera,
  type HeraDomainErrorCode,
  HeraError,
  type HeraRpcFail,
} from "../src/index"

// The accounts contract's failure codes that are not in HERA_ERROR_CATALOG, at their contract
// statuses, as a consumer's accounts contract declares them.
const ACCOUNTS_CODES = {
  member_deactivated: { status: 403 },
  member_not_found: { status: 404 },
  invalid_device: { status: 400 },
  invalid_user_code: { status: 404 },
  already_decided: { status: 409 },
  slow_down: { status: 400 },
  authorization_pending: { status: 400 },
  access_denied: { status: 400 },
  expired_token: { status: 400 },
  invalid_grant: { status: 400 },
  invalid_secret: { status: 401 },
  already_bootstrapped: { status: 409 },
  invalid_workspace_id: { status: 400 },
  not_bootstrapped: { status: 409 },
  invalid_pair: { status: 400 },
  service_token_limit: { status: 409 },
} as const

const AccountsCodes = HeraError.codes("accounts", ACCOUNTS_CODES)
type AccountsCode = keyof typeof ACCOUNTS_CODES

const DeviceCodeSlowDown = AccountsCodes.define("DeviceCodeSlowDown", {
  code: "slow_down",
  fields: { interval: Schema.Number },
})
const MemberDeactivated = AccountsCodes.define("MemberDeactivated", {
  code: "member_deactivated",
})

const failWith = Hera.rpcMethod({
  name: "Accounts.failWith",
  service: "accounts",
  input: Schema.Struct({ code: Schema.String }),
  handler: (input) =>
    Effect.gen(function* () {
      if (input.code === "slow_down") {
        return yield* new DeviceCodeSlowDown({ interval: 10 })
      }
      if (input.code === "member_deactivated") {
        return yield* new MemberDeactivated()
      }
      return yield* Effect.fail(
        AccountsCodes.make(input.code as AccountsCode)
      )
    }),
})

describe("HeraError.codes — per-service domain codes across rpcMethod", () => {
  // admits: a domain code reaching the wire at 503 (catalog fallback) instead of its declared status; the status is copied through Exit marshalling at runtime, which no checker sees
  it.each(Object.entries(ACCOUNTS_CODES))(
    "rpcMethod fails with %s at its declared status, not 503",
    async (code, { status }) => {
      const wire = structuredClone(await failWith({ code }))
      expect(wire).toMatchObject({ ok: false, status, code, error: code })
      expect(AccountsCodes.status(code as AccountsCode)).toBe(status)
    }
  )

  // admits: a defined error's field dropped between the handler and the RPC / problem+json wire; sanitizing and hoisting are runtime
  it("carries slow_down's interval in the fields slot, and top-level in problem+json", async () => {
    const wire = structuredClone(await failWith({ code: "slow_down" }))
    expect(wire).toMatchObject({
      ok: false,
      status: 400,
      code: "slow_down",
      fields: { interval: 10 },
    })
    const body = (await new DeviceCodeSlowDown({ interval: 15 })
      .toResponse()
      .json()) as Record<string, unknown>
    expect(body).toMatchObject({
      status: 400,
      code: "slow_down",
      type: "urn:hera:error:slow_down",
      interval: 15,
      fields: { interval: 15 },
    })
  })

  // admits: the calling side rewriting a declared code to <service>_unavailable; decode of an untrusted wire value is runtime
  it("rpcClient keeps a domain code and its declared status only when handed the registry", async () => {
    const binding = { failWith }
    const withCodes = Hera.rpcClient(binding, {
      service: "accounts",
      codes: [AccountsCodes],
    })
    const kept = await Effect.runPromise(
      Effect.flip(withCodes.failWith({ code: "member_deactivated" }))
    )
    expect(kept.code).toBe("member_deactivated")
    expect(kept.status).toBe(403)
    expect(AccountsCodes.has(kept.code)).toBe(true)

    const slow = await Effect.runPromise(
      Effect.flip(withCodes.failWith({ code: "slow_down" }))
    )
    expect(slow.fields).toEqual({ interval: 10 })

    const without = Hera.rpcClient(binding, { service: "accounts" })
    const lost = await Effect.runPromise(
      Effect.flip(without.failWith({ code: "member_deactivated" }))
    )
    expect(lost.code).toBe("accounts_unavailable")
  })

  // admits: a registry shadowing catalog vocabulary through a cast or non-literal spec; the runtime throw is the backstop for the type guard
  it("refuses a code that is not snake_case, shadows the catalog or a template, or has a bad status", () => {
    expect(() =>
      // @ts-expect-error a catalog code cannot be redeclared
      HeraError.codes("x", { not_found: { status: 404 } })
    ).toThrow(/collides/)
    expect(() =>
      // @ts-expect-error a template suffix cannot be declared
      HeraError.codes("x", { ledger_unavailable: { status: 503 } })
    ).toThrow(/collides/)
    expect(() => HeraError.codes("x", { SlowDown: { status: 400 } })).toThrow(
      /snake_case/
    )
    expect(() =>
      // @ts-expect-error 418 is outside HeraErrorStatus
      HeraError.codes("x", { teapot: { status: 418 } })
    ).toThrow(/status/)
  })

  // admits: nothing at runtime; hosts the type-rung assertions, which tsc checks over this file
  it("keeps domain codes behind the registry at the type level", () => {
    // @ts-expect-error a raw string is not a domain code
    const raw: HeraDomainErrorCode<"slow_down"> = "slow_down"
    // @ts-expect-error HeraError.define stays catalog-only
    HeraError.define("Raw", { code: "member_deactivated", status: 403 })
    expect(raw).toBe("slow_down")
  })

  // admits: nothing at runtime; hosts the contract-arm assignability, which tsc checks over this file
  it("types each defined error's wire fail as its polaris contract arm", () => {
    type Fail<S extends number, C extends string> = {
      readonly ok: false
      readonly status: S
      readonly code: C
    }
    type WireOf<E> = E extends {
      readonly code: infer C extends HeraDomainErrorCode
      readonly status: infer S extends 400 | 403
    }
      ? HeraRpcFail<C, S>
      : never
    const deactivated: Fail<403, "member_deactivated"> = {} as WireOf<
      InstanceType<typeof MemberDeactivated>
    >
    const slowDown: Fail<400, "slow_down"> = {} as WireOf<
      InstanceType<typeof DeviceCodeSlowDown>
    >
    const codeLiteral: "slow_down" = AccountsCodes.codes.slow_down
    expect([deactivated, slowDown, codeLiteral]).toHaveLength(3)
  })
})
