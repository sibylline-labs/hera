import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { OrgId } from "../../core/schema/index.js"
import { withJurisdiction } from "./naming.js"
import {
  type HeraGetTenantRunStubOptions,
  type OrgRunDurableObjectName,
  TenantIdentityError,
} from "./types.js"

const ORG_PREFIX = "org:"
const RUN_SEPARATOR = ":run:"
/** Printable ASCII with no whitespace, 1 to 256 characters: a run key may carry `:` but nothing a log or URL mangles. */
const RUN_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/

/** One run of one org: the org it bills and logs as, and the opaque run key the consumer chose. */
export interface OrgRun {
  readonly orgId: OrgId
  readonly runKey: string
}

/** Whether `runKey` is a valid run key: 1 to 256 printable ASCII characters, no whitespace. */
export function isRunKey(runKey: unknown): runKey is string {
  return typeof runKey === "string" && RUN_KEY_PATTERN.test(runKey)
}

/**
 * Names the Durable Object of one run of one org, `org:<OrgId>:run:<runKey>`. The same pair always
 * names the same object. Throws `TenantIdentityError` on an invalid `OrgId` or run key, without
 * echoing either.
 */
export function orgRunDoName(orgId: OrgId, runKey: string): OrgRunDurableObjectName {
  if (Option.isNone(Schema.decodeUnknownOption(OrgId)(orgId))) {
    throw new TenantIdentityError({ reason: "orgRunDoName requires a valid branded OrgId" })
  }
  if (!isRunKey(runKey)) {
    throw new TenantIdentityError({ reason: "orgRunDoName requires a run key of 1-256 printable ASCII characters" })
  }
  return `${ORG_PREFIX}${orgId}${RUN_SEPARATOR}${runKey}`
}

/**
 * Parses `org:<OrgId>:run:<runKey>`. An `OrgId` carries no `:`, so the first `:run:` after the
 * prefix ends it; the rest is the run key and may itself contain `:`. Any other shape is `none`.
 */
export function parseOrgRunDoName(name: unknown): Option.Option<OrgRun> {
  if (typeof name !== "string" || !name.startsWith(ORG_PREFIX)) return Option.none()
  const rest = name.slice(ORG_PREFIX.length)
  const at = rest.indexOf(RUN_SEPARATOR)
  if (at <= 0) return Option.none()
  const runKey = rest.slice(at + RUN_SEPARATOR.length)
  if (!isRunKey(runKey)) return Option.none()
  return Option.map(Schema.decodeUnknownOption(OrgId)(rest.slice(0, at)), (orgId) => ({ orgId, runKey }))
}

/** Resolves a run-keyed object's `ctx.id.name`, failing closed (never echoing the raw name). */
export function requireTenantRunDoName(rawName: string | undefined | null): OrgRun {
  const parsed = parseOrgRunDoName(rawName)
  if (Option.isNone(parsed)) {
    throw new TenantIdentityError({
      reason:
        rawName === undefined || rawName === null
          ? "Durable Object ctx.id.name is missing (anonymous DO instances are not permitted for a run-keyed TenantDurableObject)"
          : "Durable Object ctx.id.name is not a valid org:<OrgId>:run:<runKey> name",
    })
  }
  return parsed.value
}

/**
 * The stub of one run's object, named by `orgRunDoName`. Takes a branded `OrgId` and the run key
 * the consumer derived itself; pins the jurisdiction exactly as `getTenantStub` does.
 */
export function getTenantRunStub<T extends Rpc.DurableObjectBranded | undefined = undefined>(
  namespace: DurableObjectNamespace<T>,
  orgId: OrgId,
  runKey: string,
  options?: HeraGetTenantRunStubOptions
): DurableObjectStub<T> {
  const name = orgRunDoName(orgId, runKey)
  const target = withJurisdiction(namespace, options)
  return target.get(target.idFromName(name))
}
