/**
 * Hex-encoded symmetric/signing key reader (`HeraConfig.hexKey`).
 */

import {
  createSecretReader,
  makeSingleIssueInvalid,
  makeUnconfigured,
  makeValid,
  readRawSecret,
} from "./env-reader.js";
import type { EnvSource, SecretReader, SecretStatus } from "./types.js";

export const HEX_PATTERN = /^[0-9a-fA-F]+$/;

export function decodeHexBytes(hex: string): Uint8Array {
  const byteLength = hex.length / 2;
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function evaluateHexKey(
  env: EnvSource,
  envKey: string,
  byteLength: number = 32,
): SecretStatus<Uint8Array> {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} has invalid configured byteLength: expected positive integer`,
      "InvalidValue",
      "positive integer byteLength",
    );
  }

  const rawState = readRawSecret(env, envKey);
  if (rawState.kind === "unconfigured") {
    return makeUnconfigured(envKey);
  }
  const expectedHexLength = byteLength * 2;
  const expectedDescription = `${byteLength}-byte hex key (${expectedHexLength} hex chars)`;

  if (rawState.kind === "invalid_type") {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} failed hexKey validation: expected ${expectedDescription}`,
      "InvalidType",
      expectedDescription,
    );
  }

  const normalized = rawState.value;
  if (!HEX_PATTERN.test(normalized)) {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} failed hexKey validation: non-hexadecimal characters present (expected ${expectedDescription})`,
      "Filter",
      expectedDescription,
    );
  }

  if (normalized.length !== expectedHexLength) {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} failed hexKey validation: invalid length (expected ${expectedDescription})`,
      "InvalidValue",
      expectedDescription,
    );
  }

  return makeValid(envKey, decodeHexBytes(normalized));
}

/**
 * Reads a hex-encoded symmetric/signing key (default 32 bytes / 64 hex chars) from `env[envKey]`,
 * strips a single trailing `\n` or `\r\n`, and returns `Redacted<Uint8Array>`.
 *
 * Supports both `HeraConfig.hexKey(envKey, byteLength?)` and `HeraConfig.hexKey(env, envKey, byteLength?)`.
 */
export function hexKey(
  envKey: string,
  byteLength?: number,
): SecretReader<Uint8Array>;
export function hexKey(
  env: EnvSource,
  envKey: string,
  byteLength?: number,
): SecretStatus<Uint8Array>;
export function hexKey(
  envOrKey: EnvSource | string,
  keyOrByteLength?: string | number,
  maybeByteLength?: number,
): SecretReader<Uint8Array> | SecretStatus<Uint8Array> {
  if (typeof envOrKey === "string") {
    const envKey = envOrKey;
    const byteLength =
      typeof keyOrByteLength === "number" ? keyOrByteLength : 32;
    return createSecretReader(envKey, (env) =>
      evaluateHexKey(env, envKey, byteLength),
    );
  }
  const env = envOrKey;
  const envKey = keyOrByteLength as string;
  const byteLength = maybeByteLength ?? 32;
  return evaluateHexKey(env, envKey, byteLength);
}
