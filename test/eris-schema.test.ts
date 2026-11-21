import { describe, expect, test } from "vitest";
import { Option, Result } from "effect";
import * as Schema from "effect/Schema";
import {
  CANONICAL_ENV_NAMES,
  decodeResult,
  decodeSync,
  decodeUnknownSync,
  encodeSync,
  EnvName,
  ERROR_SLUG_PATTERN,
  ErrorSlug,
  GCP_PROJECT_ID_PATTERN,
  GcpProjectId,
  HeraSchemaError,
  KEY_NAME_PATTERN,
  KeyName,
  LOGFIRE_PROJECT_PATTERN,
  LogfireProject,
  parseSrn,
  SERVICE_NAME_PATTERN,
  ServiceName,
  SRN_KINDS,
  SRN_PATTERN,
  Srn,
  SrnKindSchema,
} from "../src/core/schema/index.js";

const erisPrimitiveMatrix = [
  {
    name: "ServiceName",
    schema: ServiceName,
    pattern: SERVICE_NAME_PATTERN,
    valid: [
      "a",
      "zenith-api",
      "polaris",
      "eris-cli",
      "badge-app-v2",
      "a".repeat(63),
    ],
    invalid: [
      "",
      "ZenithApi",
      "zenith_api",
      "-zenith",
      "zenith-",
      "zenith--api",
      "1service",
      "a".repeat(64),
    ],
  },
  {
    name: "EnvName",
    schema: EnvName,
    pattern: ENV_NAME_PATTERN_REF(),
    valid: [
      ...CANONICAL_ENV_NAMES,
      "pr-142",
      "eu-west-1",
      "a",
      "a".repeat(32),
    ],
    invalid: [
      "",
      "PROD",
      "prod_uc1",
      "-dev",
      "dev-",
      "dev--1",
      "1prod",
      "a".repeat(33),
    ],
  },
  {
    name: "KeyName",
    schema: KeyName,
    pattern: KEY_NAME_PATTERN,
    valid: [
      "A",
      "DATABASE_URL",
      "TURNKEY_API_PRIVATE_KEY",
      "CF_ACCOUNT_ID_2",
      "A".repeat(128),
    ],
    invalid: [
      "",
      "database_url",
      "Database_Url",
      "1_KEY",
      "_LEADING_UNDERSCORE",
      "KEY-WITH-HYPHEN",
      "A".repeat(129),
    ],
  },
  {
    name: "GcpProjectId",
    schema: GcpProjectId,
    pattern: GCP_PROJECT_ID_PATTERN,
    valid: [
      "abcdef",
      "example-proj-01",
      "zenith-staging",
      "a" + "b".repeat(28) + "c",
    ],
    invalid: [
      "abcde",
      "Example-proj",
      "sibylline_prod",
      "-example-proj",
      "example-proj-",
      "1example-proj",
      "a" + "b".repeat(29) + "c",
    ],
  },
  {
    name: "LogfireProject",
    schema: LogfireProject,
    pattern: LOGFIRE_PROJECT_PATTERN,
    valid: ["zenith-api", "dev", "a", "1password", "polaris-graph-v1", "a".repeat(50)],
    invalid: [
      "",
      " ",
      " zenith-api",
      "zenith api",
      "Zenith-api",
      "zenith_api",
      "-zenith-api",
      "zenith-api-",
      "zenith--api",
      "a".repeat(51),
    ],
  },
  {
    name: "ErrorSlug",
    schema: ErrorSlug,
    pattern: ERROR_SLUG_PATTERN,
    valid: [
      "a-b",
      "key-undeclared",
      "seam-missing-target",
      "graph-cycle",
      "rate-limit-exceeded-v2",
    ],
    invalid: [
      "",
      "ab",
      "singleword",
      "Key-Undeclared",
      "key_undeclared",
      "-key-undeclared",
      "key-undeclared-",
      "key--undeclared",
      "1key-undeclared",
      "a-" + "b".repeat(127),
    ],
  },
  {
    name: "Srn",
    schema: Srn,
    pattern: SRN_PATTERN,
    valid: [
      "srn:sibylline:zenith-api:prod:secret:DATABASE_URL",
      "srn:sibylline:polaris:prod-uc1:service:graph-worker",
      "srn:sibylline:badge-app:staging:flag:enable-orders-v2",
      "srn:service:zenith-api",
      "srn:key:zenith-api/DATABASE_URL",
      ["srn:seam:zenith-api->", "polaris/v1/yaks"].join(""),
      "srn:contract:graph-contract/v0",
    ],
    invalid: [
      "",
      "arn:aws:s3:::my-bucket",
      "srn:unknown_kind:zenith-api",
      "srn:sibylline:ZenithApi:prod:service:api",
      "srn:sibylline:zenith-api:PROD:service:api",
      "srn:sibylline:zenith-api:prod:unknown_kind:api",
      "srn:sibylline:zenith-api:prod:service:",
      "srn:service:",
    ],
  },
] as const;

function ENV_NAME_PATTERN_REF(): RegExp {
  return /^(?=.{1,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
}

describe("Eris branded primitives (src/schema/eris.ts)", () => {
  for (const entry of erisPrimitiveMatrix) {
    describe(entry.name, () => {
      test("accepts all valid values via make, option, is, decodeSync, and encodeSync", () => {
        for (const validValue of entry.valid) {
          expect(entry.pattern.test(validValue)).toBe(true);

          const branded = entry.schema.make(validValue);
          expect<string>(branded).toBe(validValue);
          expect(entry.schema.is(validValue)).toBe(true);

          const opt: Option.Option<string> = entry.schema.option(validValue);
          expect(Option.isSome(opt)).toBe(true);
          if (Option.isSome(opt)) {
            expect(opt.value).toBe(validValue);
          }

          const decoded = decodeSync(
            entry.schema as unknown as Schema.Top,
          )(validValue);
          expect(decoded).toBe(validValue);

          const encoded = encodeSync(
            entry.schema as unknown as Schema.Top,
          )(branded);
          expect(encoded).toBe(validValue);
        }
      });

      test("rejects all invalid values across make, option, is, and decodeResult without leaking raw input", () => {
        const sensitiveInvalid = `sk_live_SUPER_SECRET_${entry.name}_TOKEN_999`;
        const allInvalid = [...entry.invalid, sensitiveInvalid];

        for (const invalidValue of allInvalid) {
          expect(entry.schema.is(invalidValue)).toBe(false);

          const invalidOpt: Option.Option<string> =
            entry.schema.option(invalidValue);
          expect(Option.isNone(invalidOpt)).toBe(true);

          expect(() => entry.schema.make(invalidValue)).toThrow();

          const res = decodeResult(
            entry.schema as unknown as Schema.Top,
          )(invalidValue);
          expect(Result.isFailure(res)).toBe(true);
          if (Result.isFailure(res)) {
            expect(res.failure).toBeInstanceOf(HeraSchemaError);
            expect(res.failure._tag).toBe("HeraSchemaError");
            const serialized = JSON.stringify(res.failure);
            expect(serialized).not.toContain("sk_live_SUPER_SECRET");
            expect(res.failure.message).not.toContain("sk_live_SUPER_SECRET");
          }
        }
      });
    });
  }

  test("SrnKindSchema validates all 18 closed SRN kinds", () => {
    expect(SRN_KINDS.length).toBe(18);
    for (const kind of SRN_KINDS) {
      expect(decodeUnknownSync(SrnKindSchema)(kind)).toBe(kind);
    }
    expect(() => decodeUnknownSync(SrnKindSchema)("not_a_kind")).toThrow(
      HeraSchemaError,
    );
  });

  test("parseSrn extracts { service, env, kind, id, raw } from canonical 5-segment and compact 3-segment SRNs", () => {
    const canonical = Srn.make(
      "srn:sibylline:zenith-api:prod-uc1:secret:DATABASE_URL",
    );
    const parsedCanonical = parseSrn(canonical);
    expect(parsedCanonical).toEqual({
      service: ServiceName.make("zenith-api"),
      env: EnvName.make("prod-uc1"),
      kind: "secret",
      id: "DATABASE_URL",
      raw: canonical,
    });

    const compactService = Srn.make("srn:service:polaris");
    expect(parseSrn(compactService)).toEqual({
      service: ServiceName.make("polaris"),
      env: EnvName.make("global"),
      kind: "service",
      id: "polaris",
      raw: compactService,
    });

    const compactScopedKey = Srn.make("srn:key:zenith-api/DATABASE_URL");
    expect(parseSrn(compactScopedKey)).toEqual({
      service: ServiceName.make("zenith-api"),
      env: EnvName.make("global"),
      kind: "key",
      id: "DATABASE_URL",
      raw: compactScopedKey,
    });

    const compactGlobalContract = Srn.make("srn:contract:graph-contract-v0");
    expect(parseSrn(compactGlobalContract)).toEqual({
      service: ServiceName.make("global"),
      env: EnvName.make("global"),
      kind: "contract",
      id: "graph-contract-v0",
      raw: compactGlobalContract,
    });
  });

  test("enforces compile-time nominal brand isolation across Eris primitives", () => {
    const svc: ServiceName = ServiceName.make("zenith-api");
    const env: EnvName = EnvName.make("prod");
    const key: KeyName = KeyName.make("DATABASE_URL");
    const gcp: GcpProjectId = GcpProjectId.make("example-proj-01");
    const logfire: LogfireProject = LogfireProject.make("zenith-api");
    const slug: ErrorSlug = ErrorSlug.make("key-undeclared");
    const srn: Srn = Srn.make("srn:service:zenith-api");

    // @ts-expect-error raw string is not assignable to ServiceName
    const _badSvcFromString: ServiceName = "zenith-api";
    // @ts-expect-error EnvName is not assignable to ServiceName
    const _badSvcFromEnv: ServiceName = env;
    // @ts-expect-error ServiceName is not assignable to EnvName
    const _badEnvFromSvc: EnvName = svc;
    // @ts-expect-error raw string is not assignable to KeyName
    const _badKeyFromString: KeyName = "DATABASE_URL";
    // @ts-expect-error raw string is not assignable to GcpProjectId
    const _badGcpFromString: GcpProjectId = "example-proj-01";
    // @ts-expect-error raw string is not assignable to LogfireProject
    const _badLogfireFromString: LogfireProject = "zenith-api";
    // @ts-expect-error GcpProjectId is not assignable to LogfireProject
    const _badLogfireFromGcp: LogfireProject = gcp;
    // @ts-expect-error raw string is not assignable to ErrorSlug
    const _badSlugFromString: ErrorSlug = "key-undeclared";
    // @ts-expect-error raw string is not assignable to Srn
    const _badSrnFromString: Srn = "srn:service:zenith-api";

    expect([
      svc,
      env,
      key,
      gcp,
      logfire,
      slug,
      srn,
      _badSvcFromString,
      _badSvcFromEnv,
      _badEnvFromSvc,
      _badKeyFromString,
      _badGcpFromString,
      _badLogfireFromString,
      _badLogfireFromGcp,
      _badSlugFromString,
      _badSrnFromString,
    ]).toHaveLength(16);
  });
});
