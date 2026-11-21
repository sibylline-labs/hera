/**
 * Branded nominal ID primitives, Eris primitives, and value-stripping `Schema` decoders.
 */

import { brandedId } from "./brand/factory.js";
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
} from "./brand/ids.js";
import {
  decode,
  decodeResult,
  decodeResultStrict,
  decodeSync,
  decodeSyncStrict,
  decodeUnknownEffect,
  decodeUnknownEffectStrict,
  decodeUnknownSync,
  encodeSync,
} from "./decode/decoders.js";
import { HeraSchemaError, isHeraSchemaError } from "./decode/error.js";
import { formatIssues } from "./decode/issue-formatter.js";
import {
  CANONICAL_ENV_NAMES,
  EnvName,
  ErrorSlug,
  GcpProjectId,
  KeyName,
  LogfireProject,
  SRN_KINDS,
  ServiceName,
  Srn,
  SrnKindSchema,
  parseSrn,
} from "./eris/index.js";

export * from "./decode/error.js";
export * from "./decode/ast-describer.js";
export * from "./decode/issue-formatter.js";
export * from "./decode/decoders.js";
export * from "./brand/factory.js";
export * from "./brand/ids.js";
export * from "./eris/index.js";

/**
 * Unified `HeraSchema` namespace exposing branded ID primitives, Eris primitives, factory, and
 * value-stripping decode/encode/issue-formatting utilities.
 */
export const HeraSchema = {
  brandedId,
  formatIssues,
  decode,
  decodeUnknownEffect,
  decodeUnknownEffectStrict,
  decodeResult,
  decodeResultStrict,
  decodeSync,
  decodeSyncStrict,
  decodeUnknownSync,
  encodeSync,
  HeraSchemaError,
  isHeraSchemaError,
  // Branded IDs
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
  // Eris branded primitives & SRN parser
  SRN_KINDS,
  SrnKindSchema,
  CANONICAL_ENV_NAMES,
  Srn,
  parseSrn,
  ServiceName,
  EnvName,
  KeyName,
  GcpProjectId,
  LogfireProject,
  ErrorSlug,
} as const;
