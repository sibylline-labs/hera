/**
 * Canonical branded nominal ID primitives.
 */

import type * as Schema from "effect/Schema";
import { brandedId } from "./factory.js";

/**
 * Canonical 26-character Crockford Base32 ULID (`^[0-9A-HJKMNP-TV-Z]{26}$`).
 */
export const Ulid = brandedId("Ulid", /^[0-9A-HJKMNP-TV-Z]{26}$/, {
  title: "ULID",
  description: "26-character uppercase Crockford Base32 ULID",
});
export type Ulid = Schema.Schema.Type<typeof Ulid>;

/**
 * Organization ID (`^(?:org_)?[0-9A-HJKMNP-TV-Z]{26}$`).
 *
 * `org_<ULID>` is canonical; a bare `<ULID>` is accepted as an alias.
 * Decoding never rewrites the value: a tenant Durable Object's name addresses its stored
 * SQLite, so `org:<ULID>` and `org:org_<ULID>` are distinct objects.
 */
export const OrgId = brandedId("OrgId", /^(?:org_)?[0-9A-HJKMNP-TV-Z]{26}$/, {
  title: "Organization ID",
  description:
    "ULID organization identifier: canonical org_<ULID>, bare <ULID> accepted as an alias",
});
export type OrgId = Schema.Schema.Type<typeof OrgId>;

/**
 * Canonical Actor ID (`^act_[0-9A-HJKMNP-TV-Z]{26}$`).
 */
export const ActorId = brandedId("ActorId", /^act_[0-9A-HJKMNP-TV-Z]{26}$/, {
  title: "Actor ID",
  description: "Prefixed ULID actor identifier (act_<ULID>)",
});
export type ActorId = Schema.Schema.Type<typeof ActorId>;

/**
 * Canonical Request ID (`^req_[0-9A-HJKMNP-TV-Z]{26}$`).
 */
export const RequestId = brandedId("RequestId", /^req_[0-9A-HJKMNP-TV-Z]{26}$/, {
  title: "Request ID",
  description: "Prefixed ULID request correlation identifier (req_<ULID>)",
});
export type RequestId = Schema.Schema.Type<typeof RequestId>;

/**
 * Canonical SHA-256 hex key hash (`^[a-f0-9]{64}$`).
 */
export const KeyHash = brandedId("KeyHash", /^[a-f0-9]{64}$/, {
  title: "API Key SHA-256 Hash",
  description: "64-character lowercase hexadecimal SHA-256 digest",
});
export type KeyHash = Schema.Schema.Type<typeof KeyHash>;

/**
 * Canonical API key prefix (`^(ol|sib)_(live|test)_[a-zA-Z0-9]{8,16}$`).
 */
export const KeyPrefix = brandedId(
  "KeyPrefix",
  /^(ol|sib)_(live|test)_[a-zA-Z0-9]{8,16}$/,
  {
    title: "API Key Prefix",
    description: "API key public prefix (ol_ or sib_)",
  },
);
export type KeyPrefix = Schema.Schema.Type<typeof KeyPrefix>;

/**
 * Canonical Event ID (`^evt_[0-9A-HJKMNP-TV-Z]{26}$`).
 */
export const EventId = brandedId("EventId", /^evt_[0-9A-HJKMNP-TV-Z]{26}$/, {
  title: "Event ID",
  description: "Prefixed ULID event identifier (evt_<ULID>)",
});
export type EventId = Schema.Schema.Type<typeof EventId>;

/**
 * Canonical Delivery ID (`^dlv_[0-9A-HJKMNP-TV-Z]{26}$`).
 */
export const DeliveryId = brandedId("DeliveryId", /^dlv_[0-9A-HJKMNP-TV-Z]{26}$/, {
  title: "Delivery ID",
  description: "Prefixed ULID webhook/event delivery identifier (dlv_<ULID>)",
});
export type DeliveryId = Schema.Schema.Type<typeof DeliveryId>;

/**
 * Canonical Subscription ID (`^sub_[0-9A-HJKMNP-TV-Z]{26}$`).
 */
export const SubscriptionId = brandedId(
  "SubscriptionId",
  /^sub_[0-9A-HJKMNP-TV-Z]{26}$/,
  {
    title: "Subscription ID",
    description: "Prefixed ULID subscription identifier (sub_<ULID>)",
  },
);
export type SubscriptionId = Schema.Schema.Type<typeof SubscriptionId>;

/**
 * Canonical Account ID (`^acc_[0-9A-HJKMNP-TV-Z]{26}$`).
 */
export const AccountId = brandedId("AccountId", /^acc_[0-9A-HJKMNP-TV-Z]{26}$/, {
  title: "Account ID",
  description: "Prefixed ULID account identifier (acc_<ULID>)",
});
export type AccountId = Schema.Schema.Type<typeof AccountId>;

/**
 * Canonical Yak ID (`^yak-[0-9a-f]{4,16}$`).
 */
export const YakId = brandedId("YakId", /^yak-[0-9a-f]{4,16}$/, {
  title: "Yak ID",
  description: "Eris yak tracker identifier (yak-<hex>)",
});
export type YakId = Schema.Schema.Type<typeof YakId>;

/**
 * Canonical Cluster ID (`^cls_[0-9A-HJKMNP-TV-Z]{26}$`).
 */
export const ClusterId = brandedId("ClusterId", /^cls_[0-9A-HJKMNP-TV-Z]{26}$/, {
  title: "Cluster ID",
  description: "Prefixed ULID cluster identifier (cls_<ULID>)",
});
export type ClusterId = Schema.Schema.Type<typeof ClusterId>;

/**
 * Canonical Linear issue identifier (`^[A-Z0-9]{2,10}-[1-9][0-9]*$`). A team key may carry digits
 * (`4U-12`, `MAN8-456`, `E2E-3`), so a Linear reply naming such an issue still decodes.
 */
export const LinearIdentifier = brandedId(
  "LinearIdentifier",
  /^[A-Z0-9]{2,10}-[1-9][0-9]*$/,
  {
    title: "Linear Issue Identifier",
    description: "Linear team prefix and issue number (e.g. ABC-123)",
  },
);
export type LinearIdentifier = Schema.Schema.Type<typeof LinearIdentifier>;

/**
 * Canonical Member ID (`^mem_[0-9A-HJKMNP-TV-Z]{26}$`).
 */
export const MemberId = brandedId("MemberId", /^mem_[0-9A-HJKMNP-TV-Z]{26}$/, {
  title: "Member ID",
  description: "Prefixed ULID member identifier (mem_<ULID>)",
});
export type MemberId = Schema.Schema.Type<typeof MemberId>;
