import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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

const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const VALID_ORG_ID = `org_${VALID_ULID}`;
const VALID_ACTOR_ID = `act_${VALID_ULID}`;
const VALID_REQUEST_ID = `req_${VALID_ULID}`;
const VALID_EVENT_ID = `evt_${VALID_ULID}`;
const VALID_DELIVERY_ID = `dlv_${VALID_ULID}`;
const VALID_SUBSCRIPTION_ID = `sub_${VALID_ULID}`;
const VALID_ACCOUNT_ID = `acc_${VALID_ULID}`;
const VALID_CLUSTER_ID = `cls_${VALID_ULID}`;
const VALID_MEMBER_ID = `mem_${VALID_ULID}`;
const VALID_KEY_HASH = ["a3f5c8e9b2d1046789abcdef", "0123456789abcdef0123456789abcdef01234567"].join("");
const VALID_KEY_PREFIX_OL = ["ol_live", "AbCdEf1234"].join("_");
const VALID_KEY_PREFIX_SIB = ["sib_test", "9876543210abcdef"].join("_");
const VALID_YAK_ID = "yak-a1b2c3d4";
const VALID_LINEAR_ID = "ABC-2830";

describe("HeraSchema canonical branded ID primitives", () => {
  const canonicalMatrix = [
    {
      name: "Ulid",
      schema: Ulid,
      nsSchema: HeraSchema.Ulid,
      valid: [VALID_ULID, "01H9Z8X7W6V5T4S3R2Q1P0N9M8"],
      invalid: [
        "01arz3ndektsv4rrffq69g5fav", // lowercase not allowed
        "01ARZ3NDEKTSV4RRFFQ69G5FA", // 25 chars (too short)
        "01ARZ3NDEKTSV4RRFFQ69G5FAVX", // 27 chars (too long)
        "01ARZ3NDEKTSV4RRFFQ69G5FAI", // 'I' excluded in Crockford Base32
        "01ARZ3NDEKTSV4RRFFQ69G5FAL", // 'L' excluded in Crockford Base32
        "01ARZ3NDEKTSV4RRFFQ69G5FAO", // 'O' excluded in Crockford Base32
        "01ARZ3NDEKTSV4RRFFQ69G5FAU", // 'U' excluded in Crockford Base32
        "",
      ],
    },
    {
      name: "OrgId",
      schema: OrgId,
      nsSchema: HeraSchema.OrgId,
      valid: [VALID_ORG_ID, VALID_ULID],
      invalid: [
        `org:${VALID_ULID}`,
        `org_org_${VALID_ULID}`,
        VALID_ULID.toLowerCase(),
        VALID_ACTOR_ID,
        `ORG_${VALID_ULID}`,
        "org_01arz3ndektsv4rrffq69g5fav",
        "org_short",
      ],
    },
    {
      name: "ActorId",
      schema: ActorId,
      nsSchema: HeraSchema.ActorId,
      valid: [VALID_ACTOR_ID],
      invalid: [VALID_ULID, VALID_ORG_ID, "act_invalid"],
    },
    {
      name: "RequestId",
      schema: RequestId,
      nsSchema: HeraSchema.RequestId,
      valid: [VALID_REQUEST_ID],
      invalid: [VALID_ULID, VALID_ORG_ID, "req_invalid"],
    },
    {
      name: "KeyHash",
      schema: KeyHash,
      nsSchema: HeraSchema.KeyHash,
      valid: [VALID_KEY_HASH, "0".repeat(64), "f".repeat(64)],
      invalid: [
        "A".repeat(64), // uppercase hex rejected
        "0".repeat(63), // too short
        "0".repeat(65), // too long
        `${"0".repeat(63)}g`, // non-hex char
      ],
    },
    {
      name: "KeyPrefix",
      schema: KeyPrefix,
      nsSchema: HeraSchema.KeyPrefix,
      valid: [VALID_KEY_PREFIX_OL, VALID_KEY_PREFIX_SIB, ["ol_test", "12345678"].join("_")],
      invalid: [
        "ol_live_1234567", // 7 chars suffix (< 8)
        "ol_live_12345678901234567", // 17 chars suffix (> 16)
        "aws_live_12345678", // wrong vendor prefix
        "ol_dev_12345678", // wrong env segment
        "ol_live_1234-567", // non-alphanumeric suffix
      ],
    },
    {
      name: "EventId",
      schema: EventId,
      nsSchema: HeraSchema.EventId,
      valid: [VALID_EVENT_ID],
      invalid: [VALID_ULID, VALID_DELIVERY_ID, "evt_123"],
    },
    {
      name: "DeliveryId",
      schema: DeliveryId,
      nsSchema: HeraSchema.DeliveryId,
      valid: [VALID_DELIVERY_ID],
      invalid: [VALID_ULID, VALID_EVENT_ID, "dlv_123"],
    },
    {
      name: "SubscriptionId",
      schema: SubscriptionId,
      nsSchema: HeraSchema.SubscriptionId,
      valid: [VALID_SUBSCRIPTION_ID],
      invalid: [VALID_ULID, VALID_ACCOUNT_ID, "sub_123"],
    },
    {
      name: "AccountId",
      schema: AccountId,
      nsSchema: HeraSchema.AccountId,
      valid: [VALID_ACCOUNT_ID],
      invalid: [VALID_ULID, VALID_SUBSCRIPTION_ID, "acc_123"],
    },
    {
      name: "YakId",
      schema: YakId,
      nsSchema: HeraSchema.YakId,
      valid: [VALID_YAK_ID, "yak-0123", "yak-0123456789abcdef"],
      invalid: [
        "yak-123", // < 4 hex chars
        "yak-0123456789abcdef0", // > 16 hex chars
        "yak-ABCD", // uppercase rejected
        "yak_a1b2", // underscore instead of hyphen
      ],
    },
    {
      name: "ClusterId",
      schema: ClusterId,
      nsSchema: HeraSchema.ClusterId,
      valid: [VALID_CLUSTER_ID],
      invalid: [VALID_ULID, VALID_ORG_ID, "cls_123"],
    },
    {
      name: "LinearIdentifier",
      schema: LinearIdentifier,
      nsSchema: HeraSchema.LinearIdentifier,
      valid: [VALID_LINEAR_ID, "ABC-1", "ABCDEFGHIJ-60", "ABCDEFG-12345", "4U-12", "MAN8-456", "E2E-3"],
      invalid: [
        "A-1", // prefix < 2 chars
        "ABCDEFGHIJK-1", // prefix > 10 chars
        "ABC-0", // leading zero in issue number
        "ABC-01", // leading zero in issue number
        "abc-2830", // lowercase prefix
        "ABC_2830", // underscore
      ],
    },
    {
      name: "MemberId",
      schema: MemberId,
      nsSchema: HeraSchema.MemberId,
      valid: [VALID_MEMBER_ID],
      invalid: [VALID_ULID, VALID_ORG_ID, "mem_123"],
    },
  ] as const;

  for (const entry of canonicalMatrix) {
    describe(entry.name, () => {
      it("exposes matching top-level and HeraSchema namespace exports with brand metadata", () => {
        expect(entry.schema).toBe(entry.nsSchema);
        expect(entry.schema.brandName).toBe(entry.name);
        expect(entry.schema.pattern).toBeInstanceOf(RegExp);
      });

      it("accepts valid ID strings across make, is, option, decodeSync, decodeResult, and decode", () => {
        for (const validValue of entry.valid) {
          expect(entry.schema.is(validValue)).toBe(true);
          expect(entry.schema.make(validValue)).toBe(validValue);

          const opt: Option.Option<string> = entry.schema.option(validValue);
          expect(Option.isSome(opt)).toBe(true);
          if (Option.isSome(opt)) {
            expect(opt.value).toBe(validValue);
          }

          expect(HeraSchema.decodeSync(entry.schema, validValue)).toBe(validValue);
          expect(HeraSchema.decodeSync(entry.schema)(validValue)).toBe(validValue);

          const res = HeraSchema.decodeResult(entry.schema, validValue);
          expect(Result.isSuccess(res)).toBe(true);
          if (Result.isSuccess(res)) {
            expect(res.success).toBe(validValue);
          }

          const effVal = Effect.runSync(HeraSchema.decode(entry.schema, validValue));
          expect(effVal).toBe(validValue);

          expect(HeraSchema.encodeSync(entry.schema, entry.schema.make(validValue))).toBe(
            validValue,
          );
        }
      });

      it("rejects invalid strings and non-strings without echoing the rejected value", () => {
        for (const invalidValue of entry.invalid) {
          const secretSentinel = `${invalidValue}_SECRET_SENTINEL_9918273`;
          expect(entry.schema.is(secretSentinel)).toBe(false);
          const invalidOpt: Option.Option<string> = entry.schema.option(secretSentinel);
          expect(Option.isNone(invalidOpt)).toBe(true);

          let thrown: unknown;
          try {
            entry.schema.make(secretSentinel);
          } catch (err) {
            thrown = err;
          }
          expect(isHeraSchemaError(thrown)).toBe(true);
          if (isHeraSchemaError(thrown)) {
            expect(thrown.message).not.toContain(secretSentinel);
            expect(JSON.stringify(thrown)).not.toContain(secretSentinel);
            expect(thrown.cause).toBeUndefined();
          }

          const res = HeraSchema.decodeResult(entry.schema, secretSentinel);
          expect(Result.isFailure(res)).toBe(true);
          if (Result.isFailure(res)) {
            expect(res.failure.message).not.toContain(secretSentinel);
            expect(JSON.stringify(res.failure)).not.toContain(secretSentinel);
            expect(res.failure.issues.length).toBeGreaterThan(0);
            expect(res.failure.issues[0]?.expected).toContain(entry.name);
          }
        }

        expect(entry.schema.is(12345)).toBe(false);
        expect(entry.schema.is(null)).toBe(false);
        expect(entry.schema.is(undefined)).toBe(false);
        expect(entry.schema.is({})).toBe(false);
      });
    });
  }

  it("enforces compile-time nominal brand non-assignability across all canonical IDs", () => {
    const orgId: OrgId = OrgId.make(VALID_ORG_ID);
    const actorId: ActorId = ActorId.make(VALID_ACTOR_ID);
    const requestId: RequestId = RequestId.make(VALID_REQUEST_ID);
    const eventId: EventId = EventId.make(VALID_EVENT_ID);
    const deliveryId: DeliveryId = DeliveryId.make(VALID_DELIVERY_ID);
    const subscriptionId: SubscriptionId = SubscriptionId.make(VALID_SUBSCRIPTION_ID);
    const accountId: AccountId = AccountId.make(VALID_ACCOUNT_ID);
    const clusterId: ClusterId = ClusterId.make(VALID_CLUSTER_ID);
    const memberId: MemberId = MemberId.make(VALID_MEMBER_ID);
    const keyHash: KeyHash = KeyHash.make(VALID_KEY_HASH);
    const keyPrefix: KeyPrefix = KeyPrefix.make(VALID_KEY_PREFIX_OL);
    const yakId: YakId = YakId.make(VALID_YAK_ID);
    const linearId: LinearIdentifier = LinearIdentifier.make(VALID_LINEAR_ID);
    const ulid: Ulid = Ulid.make(VALID_ULID);

    // Every branded ID is usable as a plain string at read sites:
    const asStrings: ReadonlyArray<string> = [
      orgId,
      actorId,
      requestId,
      eventId,
      deliveryId,
      subscriptionId,
      accountId,
      clusterId,
      memberId,
      keyHash,
      keyPrefix,
      yakId,
      linearId,
      ulid,
    ];
    expect(asStrings).toHaveLength(14);

    // Raw unbranded strings cannot be assigned to branded ID types:
    // @ts-expect-error — plain string is not assignable to OrgId
    const _rawToOrg: OrgId = VALID_ORG_ID;
    // @ts-expect-error — plain string is not assignable to Ulid
    const _rawToUlid: Ulid = VALID_ULID;

    // Distinct branded ID types are mutually non-assignable at compile time:
    // @ts-expect-error — OrgId is not assignable to ActorId
    const _orgToActor: ActorId = orgId;
    // @ts-expect-error — ActorId is not assignable to RequestId
    const _actorToReq: RequestId = actorId;
    // @ts-expect-error — RequestId is not assignable to OrgId
    const _reqToOrg: OrgId = requestId;
    // @ts-expect-error — EventId is not assignable to DeliveryId
    const _evtToDlv: DeliveryId = eventId;
    // @ts-expect-error — DeliveryId is not assignable to EventId
    const _dlvToEvt: EventId = deliveryId;
    // @ts-expect-error — SubscriptionId is not assignable to AccountId
    const _subToAcc: AccountId = subscriptionId;
    // @ts-expect-error — AccountId is not assignable to SubscriptionId
    const _accToSub: SubscriptionId = accountId;
    // @ts-expect-error — ClusterId is not assignable to MemberId
    const _clsToMem: MemberId = clusterId;
    // @ts-expect-error — MemberId is not assignable to ClusterId
    const _memToCls: ClusterId = memberId;
    // @ts-expect-error — KeyHash is not assignable to KeyPrefix
    const _hashToPrefix: KeyPrefix = keyHash;
    // @ts-expect-error — KeyPrefix is not assignable to KeyHash
    const _prefixToHash: KeyHash = keyPrefix;
    // @ts-expect-error — YakId is not assignable to LinearIdentifier
    const _yakToLinear: LinearIdentifier = yakId;
    // @ts-expect-error — LinearIdentifier is not assignable to YakId
    const _linearToYak: YakId = linearId;
    // @ts-expect-error — OrgId is not assignable to Ulid
    const _orgToUlid: Ulid = orgId;
    // @ts-expect-error — Ulid is not assignable to OrgId
    const _ulidToOrg: OrgId = ulid;

    void _rawToOrg;
    void _rawToUlid;
    void _orgToActor;
    void _actorToReq;
    void _reqToOrg;
    void _evtToDlv;
    void _dlvToEvt;
    void _subToAcc;
    void _accToSub;
    void _clsToMem;
    void _memToCls;
    void _hashToPrefix;
    void _prefixToHash;
    void _yakToLinear;
    void _linearToYak;
    void _orgToUlid;
    void _ulidToOrg;
  });
});

describe("HeraSchema.brandedId custom factory", () => {
  const WorkflowId = HeraSchema.brandedId("WorkflowId", /^wf_[a-z0-9]{8}$/, {
    title: "Workflow ID",
    description: "Custom workflow identifier",
    examples: ["wf_1234abcd"],
  });
  type WorkflowId = Schema.Schema.Type<typeof WorkflowId>;

  const StepId = HeraSchema.brandedId("StepId", /^step_[a-z0-9]{8}$/);
  type StepId = Schema.Schema.Type<typeof StepId>;

  it("validates custom patterns and enforces nominal branding", () => {
    const wf: WorkflowId = WorkflowId.make("wf_1234abcd");
    expect(wf).toBe("wf_1234abcd");
    expect(WorkflowId.is("wf_1234abcd")).toBe(true);
    expect(WorkflowId.is("step_1234abcd")).toBe(false);

    // @ts-expect-error — WorkflowId is not assignable to StepId
    const _crossAssign: StepId = wf;
    void _crossAssign;
  });

  it("composes inside Schema.Struct, Schema.Array, and Schema.Record", () => {
    const Envelope = Schema.Struct({
      orgId: OrgId,
      workflowId: WorkflowId,
      tags: Schema.Array(YakId),
    });

    const decoded = HeraSchema.decodeSync(Envelope, {
      orgId: VALID_ORG_ID,
      workflowId: "wf_1234abcd",
      tags: ["yak-deadbeef", "yak-cafe"],
    });

    expect(decoded.orgId).toBe(VALID_ORG_ID);
    expect(decoded.workflowId).toBe("wf_1234abcd");
    expect(decoded.tags).toEqual(["yak-deadbeef", "yak-cafe"]);
  });
});

describe("HeraSchema value-stripping decoder & formatIssues", () => {
  it("reports structural path and expected type on nested Struct and Array failures without input values", () => {
    const WebhookConfigSchema = Schema.Struct({
      orgId: OrgId,
      auth: Schema.Struct({
        keyHash: KeyHash,
        prefix: KeyPrefix,
      }),
      deliveries: Schema.Array(DeliveryId),
    });

    const leakedOrg = "org_SENSITIVE_LEAK_ORG_VALUE_111";
    const leakedKey = "ol_live_SUPER_SECRET_RAW_API_KEY_222";
    const leakedPrefix = "sib_live_RAW_SECRET_TOKEN_333";
    const leakedDelivery = "dlv_SECRET_DELIVERY_TOKEN_444";

    const result = HeraSchema.decodeResult(WebhookConfigSchema, {
      orgId: leakedOrg,
      auth: {
        keyHash: leakedKey,
        prefix: leakedPrefix,
      },
      deliveries: [VALID_DELIVERY_ID, leakedDelivery],
    });

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      const err = result.failure;
      const serialized = JSON.stringify({
        err,
        message: err.message,
        stack: err.stack,
        issues: err.issues,
      });

      expect(serialized).not.toContain(leakedOrg);
      expect(serialized).not.toContain(leakedKey);
      expect(serialized).not.toContain(leakedPrefix);
      expect(serialized).not.toContain(leakedDelivery);

      const paths = err.issues.map((i) => i.path);
      expect(paths).toContainEqual(["orgId"]);
      expect(paths).toContainEqual(["auth", "keyHash"]);
      expect(paths).toContainEqual(["auth", "prefix"]);
      expect(paths).toContainEqual(["deliveries", 1]);
    }
  });

  it("strips dynamic custom filter error messages that echo the rejected input", () => {
    const EchoingFilterSchema = Schema.String.pipe(
      Schema.check(
        Schema.makeFilter(
          (val: string) =>
            val.startsWith("safe_") ? true : `Rejected secret value "${val}"!`,
          {
            identifier: "SafePrefixString",
            expected: "string starting with safe_",
          },
        ),
      ),
    );

    const secretInput = "ol_live_ECHOED_BY_CUSTOM_FILTER_987654321";
    const res = HeraSchema.decodeResult(EchoingFilterSchema, secretInput);
    expect(Result.isFailure(res)).toBe(true);
    if (Result.isFailure(res)) {
      expect(res.failure.message).not.toContain(secretInput);
      expect(JSON.stringify(res.failure)).not.toContain(secretInput);
      expect(res.failure.issues[0]?.expected).toBe("string starting with safe_");
    }
  });

  it("strips unexpected property keys and dynamic record keys from issue paths", () => {
    const StrictStruct = Schema.Struct({
      orgId: OrgId,
    });

    const RecordSchema = Schema.Record(Schema.String, OrgId);

    // 1. UnexpectedKey when decoding with onExcessProperty: "error"
    const secretExcessKey = "ol_live_EXCESS_PROPERTY_KEY_SECRET";
    const rawExit = Schema.decodeUnknownExit(StrictStruct)(
      {
        orgId: VALID_ORG_ID,
        [secretExcessKey]: "some-value",
      },
      { errors: "all", onExcessProperty: "error", reportInput: true },
    );
    expect(Exit.isFailure(rawExit)).toBe(true);
    if (Exit.isFailure(rawExit)) {
      const failReason = rawExit.cause.reasons.find((r) => r._tag === "Fail");
      expect(failReason).toBeDefined();
      if (failReason && failReason._tag === "Fail") {
        const formatted = HeraSchema.formatIssues(failReason.error);
        expect(JSON.stringify(formatted)).not.toContain(secretExcessKey);
        expect(formatted[0]?.code).toBe("UnexpectedKey");
        expect(formatted[0]?.path).toEqual(["$key"]);
      }
    }

    // 2. Dynamic record key in Schema.Record
    const secretRecordKey = "sib_live_DYNAMIC_RECORD_KEY_SECRET";
    const secretRecordVal = "bad_DYNAMIC_RECORD_VAL_SECRET";
    const recordRes = HeraSchema.decodeResult(RecordSchema, {
      [secretRecordKey]: secretRecordVal,
    });
    expect(Result.isFailure(recordRes)).toBe(true);
    if (Result.isFailure(recordRes)) {
      const serialized = JSON.stringify(recordRes.failure);
      expect(serialized).not.toContain(secretRecordKey);
      expect(serialized).not.toContain(secretRecordVal);
      expect(recordRes.failure.issues[0]?.path).toEqual(["$key"]);
    }
  });

  it("strips captured inputs even when formatIssues is given a raw SchemaError created with reportInput: true", () => {
    const Payload = Schema.Struct({
      actorId: ActorId,
      count: Schema.Number,
      mode: Schema.Literals(["active", "paused"]),
    });

    const secretActor = "act_RAW_REPORT_INPUT_TRUE_SECRET_999";
    const secretMode = "mode_RAW_REPORT_INPUT_TRUE_SECRET_888";
    const rawExit = Schema.decodeUnknownExit(Payload)(
      {
        actorId: secretActor,
        count: "not-a-number-secret-777",
        mode: secretMode,
      },
      { errors: "all", reportInput: true },
    );

    expect(Exit.isFailure(rawExit)).toBe(true);
    if (Exit.isFailure(rawExit)) {
      const failReason = rawExit.cause.reasons.find((r) => r._tag === "Fail");
      expect(failReason).toBeDefined();
      if (failReason && failReason._tag === "Fail") {
        // Raw Effect SchemaError message DOES contain the input when reportInput: true
        expect(failReason.error.message).toContain(secretActor);

        // HeraSchema.formatIssues MUST strip all inputs from the exact same SchemaError / Issue
        const strippedIssues = HeraSchema.formatIssues(failReason.error);
        const strippedFromIssue = HeraSchema.formatIssues(failReason.error.issue);
        const heraError = new HeraSchemaError(strippedIssues);

        expect( HeraSchema.formatIssues(heraError) ).toEqual(strippedIssues);
        expect(strippedFromIssue).toEqual(strippedIssues);

        const serialized = JSON.stringify({
          strippedIssues,
          message: heraError.message,
          json: heraError.toJSON(),
        });
        expect(serialized).not.toContain(secretActor);
        expect(serialized).not.toContain("not-a-number-secret-777");
        expect(serialized).not.toContain(secretMode);
      }
    }
  });

  it("handles MissingKey, Union/AnyOf, and curried decode/encodeSync", async () => {
    const UnionStruct = Schema.Struct({
      id: Schema.Union([OrgId, ActorId]),
      requiredField: Schema.String,
    });

    const decodeCurried = HeraSchema.decode(UnionStruct);
    const exit = await Effect.runPromiseExit(
      decodeCurried({ id: "invalid_union_secret_value" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const dump = JSON.stringify(exit.cause);
      expect(dump).not.toContain("invalid_union_secret_value");
    }

    const encodeOrg = HeraSchema.encodeSync(OrgId);
    expect(encodeOrg(OrgId.make(VALID_ORG_ID))).toBe(VALID_ORG_ID);

    let encodeErr: unknown;
    try {
      encodeOrg("forged_secret_org_id_value" as OrgId);
    } catch (err) {
      encodeErr = err;
    }
    expect(isHeraSchemaError(encodeErr)).toBe(true);
    if (isHeraSchemaError(encodeErr)) {
      expect(JSON.stringify(encodeErr)).not.toContain("forged_secret_org_id_value");
    }
  });
});
