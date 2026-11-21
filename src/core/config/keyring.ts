/**
 * Versioned cryptographic keyring reader and rotation container (`HeraConfig.keyring`).
 */

import {
  createSecretReader,
  makeSingleIssueInvalid,
  makeUnconfigured,
  makeValid,
  readRawSecret,
} from "./env-reader.js";
import { decodeHexBytes } from "./hex-key.js";
import { readLegacyEntry, validateLegacyOptions } from "./keyring-legacy.js";
import type {
  EnvSource,
  KeyringEntry,
  KeyringOptions,
  SecretReader,
  SecretStatus,
} from "./types.js";

const NODE_INSPECT_SYMBOL = Symbol.for("nodejs.util.inspect.custom");
const KEYRING_SEGMENT_PATTERN = /^v([1-9][0-9]*):([0-9a-fA-F]+)$/;

/**
 * Versioned cryptographic keyring parsed from `v1:<hex>,v2:<hex>`.
 * Provides defense-in-depth redaction on `toString()`, `toJSON()`, and `util.inspect`
 * even after the outer `Redacted<Keyring>` envelope is unwrapped.
 */
export class Keyring {
  readonly entries: ReadonlyArray<KeyringEntry>;
  readonly keys: ReadonlyMap<string, Uint8Array>;
  readonly versions: ReadonlyArray<string>;
  readonly activeVersion: string;
  readonly activeKey: Uint8Array;
  readonly currentVersion: string;
  readonly currentKey: Uint8Array;
  readonly size: number;

  constructor(entries: ReadonlyArray<KeyringEntry>) {
    if (entries.length === 0) {
      throw new Error("Keyring requires at least one entry");
    }
    const frozenEntries = Object.freeze([...entries]);
    const keyMap = new Map<string, Uint8Array>();
    let highestEntry = frozenEntries[0]!;
    for (const entry of frozenEntries) {
      keyMap.set(entry.version, entry.key);
      if (entry.versionNumber > highestEntry.versionNumber) {
        highestEntry = entry;
      }
    }

    this.entries = frozenEntries;
    this.keys = keyMap;
    this.versions = Object.freeze(frozenEntries.map((e) => e.version));
    this.activeVersion = highestEntry.version;
    this.activeKey = highestEntry.key;
    this.currentVersion = highestEntry.version;
    this.currentKey = highestEntry.key;
    this.size = frozenEntries.length;
  }

  /**
   * Retrieves the key bytes for a version identifier (`"v1"`, `"1"`, or `1`).
   */
  get(version: string | number): Uint8Array | undefined {
    const normalized =
      typeof version === "number"
        ? `v${version}`
        : version.startsWith("v")
          ? version
          : `v${version}`;
    return this.keys.get(normalized);
  }

  /**
   * Returns `true` if the keyring contains the given version (`"v1"`, `"1"`, or `1`).
   */
  has(version: string | number): boolean {
    return this.get(version) !== undefined;
  }

  toString(): string {
    return "<redacted>";
  }

  toJSON(): string {
    return "<redacted>";
  }

  [NODE_INSPECT_SYMBOL](): string {
    return "<redacted>";
  }
}

function resolveKeyringByteLength(
  options?: number | KeyringOptions,
): number | undefined {
  return typeof options === "number" ? options : options?.byteLength;
}

export function evaluateKeyring(
  env: EnvSource,
  envKey: string,
  options?: number | KeyringOptions,
): SecretStatus<Keyring> {
  const configuredByteLength = resolveKeyringByteLength(options);
  if (
    configuredByteLength !== undefined &&
    (!Number.isInteger(configuredByteLength) || configuredByteLength <= 0)
  ) {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} keyring has invalid configured byteLength: expected positive integer`,
      "InvalidValue",
      "positive integer byteLength",
    );
  }

  const legacy =
    typeof options === "object" && options !== null
      ? (options.legacy ?? undefined)
      : undefined;
  const legacyShape =
    legacy === undefined
      ? undefined
      : validateLegacyOptions(envKey, legacy, configuredByteLength);
  if (legacyShape !== undefined && "_tag" in legacyShape) {
    return legacyShape;
  }

  const rawState = readRawSecret(env, envKey);
  if (rawState.kind === "unconfigured") {
    if (legacy === undefined || legacyShape === undefined) {
      return makeUnconfigured(envKey);
    }
    const entry = readLegacyEntry(env, legacy, legacyShape);
    if (entry === undefined) {
      return makeUnconfigured(envKey);
    }
    return "_tag" in entry ? entry : makeValid(legacy.key, new Keyring([entry]));
  }
  if (rawState.kind === "invalid_type") {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} failed keyring validation: expected versioned keyring string (v1:<hex>,v2:<hex>)`,
      "InvalidType",
      "versioned keyring string (v1:<hex>,v2:<hex>)",
    );
  }

  const segments = rawState.value.split(",");
  const entries: KeyringEntry[] = [];
  const seenVersions = new Set<string>();
  let expectedByteLength = configuredByteLength;

  for (let idx = 0; idx < segments.length; idx++) {
    const segment = segments[idx] ?? "";
    if (segment.length === 0) {
      return makeSingleIssueInvalid(
        envKey,
        `Secret ${envKey} failed keyring validation: empty entry at index ${idx}`,
        "Filter",
        "versioned hex key entry (v<N>:<hex>)",
        [idx],
      );
    }

    const match = KEYRING_SEGMENT_PATTERN.exec(segment);
    if (!match) {
      return makeSingleIssueInvalid(
        envKey,
        `Secret ${envKey} failed keyring validation: malformed entry at index ${idx} (expected v<N>:<hex>)`,
        "Filter",
        "versioned hex key entry (v<N>:<hex>)",
        [idx],
      );
    }

    const versionNumber = Number.parseInt(match[1]!, 10);
    const hex = match[2]!;
    const version = `v${versionNumber}`;

    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
      return makeSingleIssueInvalid(
        envKey,
        `Secret ${envKey} failed keyring validation: invalid version number at index ${idx}`,
        "InvalidValue",
        "positive integer key version (v1, v2, ...)",
        [idx],
      );
    }

    if (seenVersions.has(version)) {
      return makeSingleIssueInvalid(
        envKey,
        `Secret ${envKey} failed keyring validation: duplicate key version ${version}`,
        "InvalidValue",
        `unique key version (${version} already defined)`,
        [idx],
      );
    }
    seenVersions.add(version);

    if (hex.length % 2 !== 0) {
      return makeSingleIssueInvalid(
        envKey,
        `Secret ${envKey} failed keyring validation: entry ${version} has odd hex length`,
        "InvalidValue",
        "even-length hexadecimal key",
        [idx],
      );
    }

    const actualByteLength = hex.length / 2;
    if (expectedByteLength === undefined) {
      expectedByteLength = actualByteLength;
    } else if (actualByteLength !== expectedByteLength) {
      const expectedHexChars = expectedByteLength * 2;
      return makeSingleIssueInvalid(
        envKey,
        `Secret ${envKey} failed keyring validation: entry ${version} byte length mismatch (expected ${expectedByteLength} bytes / ${expectedHexChars} hex chars)`,
        "InvalidValue",
        `${expectedByteLength}-byte hex key (${expectedHexChars} hex chars)`,
        [idx],
      );
    }

    entries.push({
      version,
      versionNumber,
      key: decodeHexBytes(hex),
    });
  }

  return makeValid(envKey, new Keyring(entries));
}

/**
 * Reads a comma-separated versioned keyring (`v1:<hex>,v2:<hex>`) from `env[envKey]`,
 * strips a single trailing `\n` or `\r\n`, and returns `Redacted<Keyring>`.
 *
 * With `options.legacy`, an unset keyring falls back to one unversioned standard-base64 key under
 * `legacy.key` (exactly `byteLength` bytes), loaded as a one-entry keyring at `legacy.version`. A set
 * keyring always wins, and a malformed one is `Invalid`: it never falls back.
 *
 * Supports both `HeraConfig.keyring(envKey, options?)` and `HeraConfig.keyring(env, envKey, options?)`.
 */
export function keyring(
  envKey: string,
  options?: number | KeyringOptions,
): SecretReader<Keyring>;
export function keyring(
  env: EnvSource,
  envKey: string,
  options?: number | KeyringOptions,
): SecretStatus<Keyring>;
export function keyring(
  envOrKey: EnvSource | string,
  keyOrOptions?: string | number | KeyringOptions,
  maybeOptions?: number | KeyringOptions,
): SecretReader<Keyring> | SecretStatus<Keyring> {
  if (typeof envOrKey === "string") {
    const envKey = envOrKey;
    const options =
      typeof keyOrOptions === "number" ||
      (typeof keyOrOptions === "object" && keyOrOptions !== null)
        ? keyOrOptions
        : undefined;
    return createSecretReader(envKey, (env) =>
      evaluateKeyring(env, envKey, options),
    );
  }
  const env = envOrKey;
  const envKey = keyOrOptions as string;
  return evaluateKeyring(env, envKey, maybeOptions);
}
