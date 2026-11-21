import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AccountId,
  ActorId,
  ClusterId,
  DeliveryId,
  EventId,
  HeraSchema,
  HeraSchemaError,
  isHeraSchemaError,
  KeyHash,
  KeyPrefix,
  LinearIdentifier,
  MemberId,
  OrgId,
  RequestId,
  SubscriptionId,
  Ulid,
  YakId,
} from "../src/core/schema/index.js";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LOWER_HEX_ALPHABET = "0123456789abcdef";
const ALPHANUM_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const arbUlid = fc
  .array(fc.integer({ min: 0, max: CROCKFORD_ALPHABET.length - 1 }), {
    minLength: 26,
    maxLength: 26,
  })
  .map((indices) => indices.map((i) => CROCKFORD_ALPHABET[i]!).join(""));

const arbSecretToken = fc
  .tuple(
    fc.constantFrom("ol_live_", "sib_live_", "ol_test_", "sib_test_", "secret_"),
    fc
      .array(fc.integer({ min: 0, max: ALPHANUM_ALPHABET.length - 1 }), {
        minLength: 16,
        maxLength: 40,
      })
      .map((indices) => indices.map((i) => ALPHANUM_ALPHABET[i]!).join("")),
  )
  .map(([prefix, body]) => `${prefix}${body}_SENTINEL`);

/**
 * Collects every string reachable inside an error object, its properties,
 * its issues, its message, its stack, and its JSON serialization.
 */
function serializeErrorSurface(err: HeraSchemaError): string {
  return [
    String(err),
    err.message,
    err.stack ?? "",
    JSON.stringify(err),
    JSON.stringify(err.toJSON()),
    JSON.stringify(err.issues),
    err.issues.map((i) => `${i.path.map(String).join(".")}:${i.code}:${i.expected}:${i.message}`).join("|"),
  ].join("\n");
}

describe("HeraSchema property-based tests", () => {
  it("never leaks rejected secret strings across any canonical branded ID schema", () => {
    const schemas = [
      Ulid,
      OrgId,
      ActorId,
      RequestId,
      KeyHash,
      KeyPrefix,
      EventId,
      DeliveryId,
      SubscriptionId,
      AccountId,
      YakId,
      ClusterId,
      LinearIdentifier,
      MemberId,
    ] as const;

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: schemas.length - 1 }),
        arbSecretToken,
        (schemaIdx, secretCandidate) => {
          const schema = schemas[schemaIdx]!;
          // Ensure candidate does not accidentally match the target pattern
          fc.pre(!schema.pattern.test(secretCandidate));

          // 1. decodeResult
          const result = HeraSchema.decodeResult(schema, secretCandidate);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            const surface = serializeErrorSurface(result.failure);
            expect(surface).not.toContain(secretCandidate);
            expect(result.failure.cause).toBeUndefined();
          }

          // 2. .make(secretCandidate)
          let caught: unknown;
          try {
            schema.make(secretCandidate);
          } catch (err) {
            caught = err;
          }
          expect(isHeraSchemaError(caught)).toBe(true);
          if (isHeraSchemaError(caught)) {
            expect(serializeErrorSurface(caught)).not.toContain(secretCandidate);
          }

          // 3. Raw Effect SchemaError with reportInput: true passed to formatIssues
          const rawExit = Schema.decodeUnknownExit(schema)(secretCandidate, {
            errors: "all",
            reportInput: true,
          });
          expect(Exit.isFailure(rawExit)).toBe(true);
          if (Exit.isFailure(rawExit)) {
            const failReason = rawExit.cause.reasons.find((r) => r._tag === "Fail");
            if (failReason && failReason._tag === "Fail") {
              const formatted = HeraSchema.formatIssues(failReason.error);
              const wrapped = new HeraSchemaError(formatted);
              expect(serializeErrorSurface(wrapped)).not.toContain(secretCandidate);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never leaks arbitrary rejected strings in nested Structs, Arrays, Unions, or echoing custom filters", () => {
    const NestedSchema = Schema.Struct({
      tenant: Schema.Struct({
        orgId: OrgId,
        actorId: ActorId,
      }),
      credentials: Schema.Array(
        Schema.Struct({
          keyHash: KeyHash,
          customChecked: Schema.String.pipe(
            Schema.check(
              Schema.makeFilter(
                (s: string) =>
                  s === "ONLY_THIS_EXACT_SAFE_CONSTANT"
                    ? true
                    : `Custom filter echoing secret input: ${s}`,
                {
                  identifier: "ExactSafeConstant",
                  expected: "ExactSafeConstant",
                },
              ),
            ),
          ),
        }),
      ),
      target: Schema.Union([EventId, DeliveryId]),
    });

    fc.assert(
      fc.property(
        arbSecretToken,
        arbSecretToken,
        arbSecretToken,
        arbSecretToken,
        arbSecretToken,
        (secOrg, secActor, secHash, secCustom, secTarget) => {
          const payload = {
            tenant: {
              orgId: secOrg,
              actorId: secActor,
            },
            credentials: [
              {
                keyHash: secHash,
                customChecked: secCustom,
              },
            ],
            target: secTarget,
          };

          const decoded = HeraSchema.decodeResult(NestedSchema, payload);
          expect(Result.isFailure(decoded)).toBe(true);
          if (Result.isFailure(decoded)) {
            const surface = serializeErrorSurface(decoded.failure);
            expect(surface).not.toContain(secOrg);
            expect(surface).not.toContain(secActor);
            expect(surface).not.toContain(secHash);
            expect(surface).not.toContain(secCustom);
            expect(surface).not.toContain(secTarget);
          }

          const rawExit = Schema.decodeUnknownExit(NestedSchema)(payload, {
            errors: "all",
            reportInput: true,
          });
          if (Exit.isFailure(rawExit)) {
            const failReason = rawExit.cause.reasons.find((r) => r._tag === "Fail");
            if (failReason && failReason._tag === "Fail") {
              const formatted = new HeraSchemaError(
                HeraSchema.formatIssues(failReason.error),
              );
              const surface = serializeErrorSurface(formatted);
              expect(surface).not.toContain(secOrg);
              expect(surface).not.toContain(secActor);
              expect(surface).not.toContain(secHash);
              expect(surface).not.toContain(secCustom);
              expect(surface).not.toContain(secTarget);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never leaks untrusted excess property keys or dynamic Schema.Record keys", () => {
    const StrictStruct = Schema.Struct({
      orgId: OrgId,
    });
    const DynamicRecord = Schema.Record(Schema.String, OrgId);

    fc.assert(
      fc.property(arbSecretToken, arbSecretToken, (secretKey, secretValue) => {
        fc.pre(secretKey !== "orgId");

        // 1. Excess key on struct with onExcessProperty: "error"
        const rawStructExit = Schema.decodeUnknownExit(StrictStruct)(
          {
            orgId: `org_${"0".repeat(26)}`,
            [secretKey]: secretValue,
          },
          { errors: "all", onExcessProperty: "error", reportInput: true },
        );
        expect(Exit.isFailure(rawStructExit)).toBe(true);
        if (Exit.isFailure(rawStructExit)) {
          const failReason = rawStructExit.cause.reasons.find((r) => r._tag === "Fail");
          if (failReason && failReason._tag === "Fail") {
            const err = new HeraSchemaError(HeraSchema.formatIssues(failReason.error));
            const surface = serializeErrorSurface(err);
            expect(surface).not.toContain(secretKey);
            expect(surface).not.toContain(secretValue);
          }
        }

        // 2. Dynamic key and value on Schema.Record
        const recordRes = HeraSchema.decodeResult(DynamicRecord, {
          [secretKey]: secretValue,
        });
        expect(Result.isFailure(recordRes)).toBe(true);
        if (Result.isFailure(recordRes)) {
          const surface = serializeErrorSurface(recordRes.failure);
          expect(surface).not.toContain(secretKey);
          expect(surface).not.toContain(secretValue);
          expect(recordRes.failure.issues[0]?.path).toEqual(["$key"]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("round-trips all valid generated canonical prefixed ULIDs, KeyHashes, KeyPrefixes, YakIds, and LinearIdentifiers", () => {
    const arbKeyHash = fc
      .array(fc.integer({ min: 0, max: LOWER_HEX_ALPHABET.length - 1 }), {
        minLength: 64,
        maxLength: 64,
      })
      .map((indices) => indices.map((i) => LOWER_HEX_ALPHABET[i]!).join(""));

    const arbKeyPrefix = fc
      .tuple(
        fc.constantFrom("ol", "sib"),
        fc.constantFrom("live", "test"),
        fc
          .array(fc.integer({ min: 0, max: ALPHANUM_ALPHABET.length - 1 }), {
            minLength: 8,
            maxLength: 16,
          })
          .map((indices) => indices.map((i) => ALPHANUM_ALPHABET[i]!).join("")),
      )
      .map(([vendor, env, suffix]) => `${vendor}_${env}_${suffix}`);

    const arbYakId = fc
      .array(fc.integer({ min: 0, max: LOWER_HEX_ALPHABET.length - 1 }), {
        minLength: 4,
        maxLength: 16,
      })
      .map((indices) => `yak-${indices.map((i) => LOWER_HEX_ALPHABET[i]!).join("")}`);

    const arbLinearId = fc
      .tuple(
        fc
          .array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), { minLength: 2, maxLength: 10 })
          .map((chars) => chars.join("")),
        fc.integer({ min: 1, max: 999999 }),
      )
      .map(([team, num]) => `${team}-${String(num)}`);

    fc.assert(
      fc.property(
        arbUlid,
        arbKeyHash,
        arbKeyPrefix,
        arbYakId,
        arbLinearId,
        (ulid, keyHash, keyPrefix, yakId, linearId) => {
          expect(Ulid.make(ulid)).toBe(ulid);
          expect(OrgId.make(`org_${ulid}`)).toBe(`org_${ulid}`);
          expect(ActorId.make(`act_${ulid}`)).toBe(`act_${ulid}`);
          expect(RequestId.make(`req_${ulid}`)).toBe(`req_${ulid}`);
          expect(EventId.make(`evt_${ulid}`)).toBe(`evt_${ulid}`);
          expect(DeliveryId.make(`dlv_${ulid}`)).toBe(`dlv_${ulid}`);
          expect(SubscriptionId.make(`sub_${ulid}`)).toBe(`sub_${ulid}`);
          expect(AccountId.make(`acc_${ulid}`)).toBe(`acc_${ulid}`);
          expect(ClusterId.make(`cls_${ulid}`)).toBe(`cls_${ulid}`);
          expect(MemberId.make(`mem_${ulid}`)).toBe(`mem_${ulid}`);
          expect(KeyHash.make(keyHash)).toBe(keyHash);
          expect(KeyPrefix.make(keyPrefix)).toBe(keyPrefix);
          expect(YakId.make(yakId)).toBe(yakId);
          expect(LinearIdentifier.make(linearId)).toBe(linearId);

          const eff = HeraSchema.decode(OrgId, `org_${ulid}`);
          expect(Effect.runSync(eff)).toBe(`org_${ulid}`);
          expect(OrgId.make(ulid)).toBe(ulid);
          expect(Effect.runSync(HeraSchema.decode(OrgId, ulid))).toBe(ulid);
        },
      ),
      { numRuns: 200 },
    );
  });
});
