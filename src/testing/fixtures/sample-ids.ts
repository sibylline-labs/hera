import {
  AccountId,
  ActorId,
  ClusterId,
  DeliveryId,
  EventId,
  KeyHash,
  KeyPrefix,
  LinearIdentifier,
  MemberId,
  OrgId,
  RequestId,
  SubscriptionId,
  Ulid,
  YakId,
} from "../../core/schema/index.js";

export const DEFAULT_ULID = "01JAWX9Z8K4M5N6P7Q8R9S0T1V";

/**
 * Default deterministic Unix epoch timestamp in milliseconds (`2025-10-09T08:53:20.000Z`).
 */
export const DEFAULT_TEST_TIME_MS = 1_760_000_000_000;

/**
 * Deterministic pre-minted valid canonical IDs for Hera unit and integration tests.
 */
export const SAMPLE_IDS = {
  ulid: Ulid.make(DEFAULT_ULID),
  orgId: OrgId.make(`org_${DEFAULT_ULID}`),
  actorId: ActorId.make(`act_${DEFAULT_ULID}`),
  requestId: RequestId.make(`req_${DEFAULT_ULID}`),
  keyHash: KeyHash.make("a".repeat(64)),
  keyPrefix: KeyPrefix.make("sib_test_01234567"),
  eventId: EventId.make(`evt_${DEFAULT_ULID}`),
  deliveryId: DeliveryId.make(`dlv_${DEFAULT_ULID}`),
  subscriptionId: SubscriptionId.make(`sub_${DEFAULT_ULID}`),
  accountId: AccountId.make(`acc_${DEFAULT_ULID}`),
  yakId: YakId.make("yak-0123abcd"),
  clusterId: ClusterId.make(`cls_${DEFAULT_ULID}`),
  linearIdentifier: LinearIdentifier.make("ABC-123"),
  memberId: MemberId.make(`mem_${DEFAULT_ULID}`),
} as const;
