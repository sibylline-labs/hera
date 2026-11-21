import * as Option from "effect/Option"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { getTenantRunStub, Hera, orgRunDoName, parseOrgRunDoName, TenantDurableObject, TenantIdentityError } from "../src/index"
import { SAMPLE_IDS } from "../src/testing/fixtures/sample-ids"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

const ORG = SAMPLE_IDS.orgId
const BARE = ORG.replace(/^org_/, "")
const runKey = fc.stringMatching(/^[\x21-\x7e]{1,256}$/)

class RunObject extends TenantDurableObject.configure({ service: "run-object", runKeyed: true }) {}
class OrgObject extends TenantDurableObject.configure({ service: "org-object" }) {}

describe("run names", () => {
  // admits: algorithmic: the split at the first `:run:` must not cut a colon-bearing key; no type sees string positions
  it("round-trips every valid run key, `:` and `:run:` included, for both OrgId forms", () => {
    fc.assert(
      fc.property(runKey, fc.constantFrom(ORG, BARE as typeof ORG), (key, org) => {
        const parsed = parseOrgRunDoName(orgRunDoName(org, key))
        expect(Option.getOrThrow(parsed)).toEqual({ orgId: org, runKey: key })
      })
    )
    expect(Option.getOrThrow(parseOrgRunDoName(`org:${ORG}:run:resolve:x:run:1`)).runKey).toBe("resolve:x:run:1")
  })

  // admits: algorithmic: each malformed shape is its own parser branch; a miss would mint an object under a bad name
  it("refuses every malformed name and every invalid run key", () => {
    for (const name of [`org:${ORG}`, ORG, `org:${ORG}:run:`, `org::run:k`, `org:bad:run:k`, `org:${ORG}:run:a b`, `org:${ORG}:run:${"k".repeat(257)}`, `${ORG}:run:k`, `org:${ORG}:job:k`, undefined, 7]) {
      expect(Option.isNone(parseOrgRunDoName(name)), String(name)).toBe(true)
    }
    for (const key of ["", "a b", "tab\tkey", "é", "k".repeat(257)]) {
      expect(() => orgRunDoName(ORG, key)).toThrow(TenantIdentityError)
    }
    expect(() => orgRunDoName("nope" as typeof ORG, "k")).toThrow(TenantIdentityError)
  })
})

describe("a run-keyed TenantDurableObject through the test harness", () => {
  // admits: integration: the `cloudflare:workers` stub path must decode identity as workerd does, or a consumer's in-memory test accepts a name workerd refuses
  it("takes orgId and runKey from its name and refuses the per-org name", () => {
    const run = new RunObject(makeTestDurableObjectState({ idName: orgRunDoName(ORG, "resolve:e:1") }).state, {})
    expect([run.orgId, run.runKey, run.makeTenantCtx().orgId]).toEqual([ORG, "resolve:e:1", ORG])
    for (const idName of [`org:${ORG}`, ORG, null]) {
      expect(() => new RunObject(makeTestDurableObjectState({ idName }).state, {})).toThrow(TenantIdentityError)
    }
    expect(new OrgObject(makeTestDurableObjectState({ idName: `org:${ORG}` }).state, {}).runKey).toBeUndefined()
    expect(() => new OrgObject(makeTestDurableObjectState({ idName: orgRunDoName(ORG, "k") }).state, {})).toThrow(TenantIdentityError)
  })

  // admits: integration: barrel wiring; a consumer imports the helpers from `Hera`, the root barrel and the class statics
  it("exposes one set of helpers on Hera, the barrel and the class", () => {
    expect([Hera.orgRunDoName, Hera.parseOrgRunDoName, Hera.getTenantRunStub]).toEqual([orgRunDoName, parseOrgRunDoName, getTenantRunStub])
    expect([TenantDurableObject.orgRunDoName, TenantDurableObject.parseOrgRunDoName, TenantDurableObject.getTenantRunStub]).toEqual([orgRunDoName, parseOrgRunDoName, getTenantRunStub])
  })

  // admits: boundary-io: the stub helper must name the object exactly as orgRunDoName and keep the jurisdiction pin
  it("getTenantRunStub pins the jurisdiction and names the object by orgRunDoName", () => {
    const calls: string[] = []
    const ns = {
      jurisdiction: (j: string) => (calls.push(`jurisdiction:${j}`), ns),
      idFromName: (name: string) => (calls.push(`idFromName:${name}`), { name }),
      get: (id: { name: string }) => ({ id }),
    } as unknown as DurableObjectNamespace
    getTenantRunStub(ns, ORG, "resolve:e:1", { jurisdiction: "eu" })
    expect(calls).toEqual(["jurisdiction:eu", `idFromName:org:${ORG}:run:resolve:e:1`])
    expect(() => getTenantRunStub(ns, ORG, "")).toThrow(TenantIdentityError)
  })
})
