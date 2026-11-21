/**
 * Schema-validated 3-state `HeraConfig.secret` reader.
 */

import { Result, type Schema } from "effect";
import { decodeResult } from "../schema/index.js";
import {
  createSecretReader,
  makeInvalid,
  makeSingleIssueInvalid,
  makeUnconfigured,
  makeValid,
  readRawSecret,
} from "./env-reader.js";
import type {
  EnvSource,
  SecretReader,
  SecretSchema,
  SecretStatus,
} from "./types.js";

export function evaluateSecretWithSchema<S extends SecretSchema>(
  env: EnvSource,
  envKey: string,
  schema: S,
): SecretStatus<S["Type"]> {
  const rawState = readRawSecret(env, envKey);
  if (rawState.kind === "unconfigured") {
    return makeUnconfigured(envKey);
  }
  if (rawState.kind === "invalid_type") {
    return makeSingleIssueInvalid(
      envKey,
      `Secret ${envKey} failed schema validation: expected string`,
      "InvalidType",
      "string",
    );
  }

  const decoded = decodeResult(
    schema as Schema.Top & { readonly DecodingServices: never },
    rawState.value,
  );
  if (Result.isSuccess(decoded)) {
    return makeValid(envKey, decoded.success);
  }

  const issues = decoded.failure.issues;
  const expectedSummary =
    issues.map((issue) => issue.expected).join("; ") || "schema validation failed";
  return makeInvalid(
    envKey,
    `Secret ${envKey} failed schema validation: expected ${expectedSummary}`,
    issues,
  );
}

/**
 * Reads a secret from `env[envKey]`, strips a single trailing `\n` or `\r\n`,
 * validates the normalized string against `schema`, and wraps valid values in `Redacted.make(...)`.
 *
 * Supports both curried reader creation `HeraConfig.secret(envKey, schema)` and
 * direct evaluation `HeraConfig.secret(env, envKey, schema)`.
 */
export function secret<S extends SecretSchema>(
  envKey: string,
  schema: S,
): SecretReader<S["Type"]>;
export function secret<S extends SecretSchema>(
  env: EnvSource,
  envKey: string,
  schema: S,
): SecretStatus<S["Type"]>;
export function secret<S extends SecretSchema>(
  envOrKey: EnvSource | string,
  keyOrSchema: string | S,
  maybeSchema?: S,
): SecretReader<S["Type"]> | SecretStatus<S["Type"]> {
  if (typeof envOrKey === "string" && maybeSchema === undefined) {
    const envKey = envOrKey;
    const schema = keyOrSchema as S;
    return createSecretReader(envKey, (env) =>
      evaluateSecretWithSchema(env, envKey, schema),
    );
  }
  const env = envOrKey as EnvSource;
  const envKey = keyOrSchema as string;
  const schema = maybeSchema as S;
  return evaluateSecretWithSchema(env, envKey, schema);
}
