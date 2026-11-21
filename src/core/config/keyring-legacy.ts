/**
 * Legacy single-key fallback for `HeraConfig.keyring`: one unversioned standard-base64
 * key, read as a one-entry keyring while the keyring secret is unset.
 */

import { makeSingleIssueInvalid, readRawSecret } from "./env-reader.js";
import type {
  EnvSource,
  InvalidSecret,
  KeyringEntry,
  KeyringLegacyOptions,
} from "./types.js";

/** A validated `legacy` option: the entry's version number and the exact key length. */
export interface LegacyKeyShape {
  readonly versionNumber: number;
  readonly byteLength: number;
}

const LEGACY_VERSION_PATTERN = /^v([1-9][0-9]*)$/;
const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/]*$/;

function legacyDescription(byteLength: number): string {
  return `standard base64 of a ${byteLength}-byte key (${standardBase64Length(byteLength)} chars, padded)`;
}

function standardBase64Length(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

/**
 * Decodes padded standard base64 (`A-Za-z0-9+/`, `=` padding) of exactly `byteLength` bytes, or
 * returns `undefined`. Unused low bits in the final character are accepted, as `atob` accepts them.
 */
export function decodeStandardBase64(
  text: string,
  byteLength: number,
): Uint8Array | undefined {
  const padLength = (3 - (byteLength % 3)) % 3;
  if (text.length !== standardBase64Length(byteLength)) return undefined;
  const body = text.slice(0, text.length - padLength);
  if (text.slice(body.length) !== "=".repeat(padLength)) return undefined;
  if (!BASE64_BODY_PATTERN.test(body)) return undefined;
  const binary = atob(text);
  if (binary.length !== byteLength) return undefined;
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Checks the `legacy` option itself, before any env read. Returns the parsed version number and
 * the byteLength it requires, or an `Invalid` status on the keyring key.
 */
export function validateLegacyOptions(
  envKey: string,
  legacy: KeyringLegacyOptions,
  byteLength: number | undefined,
): InvalidSecret | LegacyKeyShape {
  if (byteLength === undefined) {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} keyring legacy fallback requires a configured byteLength`,
      "InvalidValue",
      "positive integer byteLength with legacy",
    );
  }
  if (
    typeof legacy.key !== "string" ||
    legacy.key.length === 0 ||
    legacy.key === envKey
  ) {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} keyring legacy fallback needs a distinct non-empty legacy key name`,
      "InvalidValue",
      "legacy env key name distinct from the keyring key",
    );
  }
  if (legacy.encoding !== "base64") {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} keyring legacy fallback has unsupported encoding: expected base64`,
      "InvalidValue",
      "legacy encoding base64",
    );
  }
  const match =
    typeof legacy.version === "string"
      ? LEGACY_VERSION_PATTERN.exec(legacy.version)
      : null;
  const versionNumber = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
  if (!Number.isSafeInteger(versionNumber)) {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} keyring legacy fallback has invalid version: expected v<N>`,
      "InvalidValue",
      "legacy key version (v1, v2, ...)",
    );
  }
  return { versionNumber, byteLength };
}

/**
 * Reads the legacy key. `undefined` when it is unset; an `Invalid` status on the legacy key when it
 * is not standard base64 of exactly `byteLength` bytes. Never echoes the value.
 */
export function readLegacyEntry(
  env: EnvSource,
  legacy: KeyringLegacyOptions,
  { versionNumber, byteLength }: LegacyKeyShape,
): KeyringEntry | InvalidSecret | undefined {
  const rawState = readRawSecret(env, legacy.key);
  if (rawState.kind === "unconfigured") return undefined;
  const expected = legacyDescription(byteLength);
  if (rawState.kind === "invalid_type") {
    return makeSingleIssueInvalid(
      legacy.key,
      `Secret ${legacy.key} failed legacy key validation: expected ${expected}`,
      "InvalidType",
      expected,
    );
  }
  const key = decodeStandardBase64(rawState.value, byteLength);
  if (key === undefined) {
    return makeSingleIssueInvalid(
      legacy.key,
      `Secret ${legacy.key} failed legacy key validation: expected ${expected}`,
      "InvalidValue",
      expected,
    );
  }
  return { version: `v${versionNumber}`, versionNumber, key };
}
