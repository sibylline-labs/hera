/**
 * Environment lookup, trailing-newline normalization, and 3-state `SecretStatus` guards.
 */

import { Effect, Layer, Redacted } from "effect";
import type { HeraSchemaIssue, HeraSchemaIssueCode } from "../schema/index.js";
import {
  type EnvSource,
  HeraConfigError,
  HeraEnv,
  type InvalidSecret,
  type RawSecretState,
  type SecretReader,
  type SecretStatus,
  type UnconfiguredSecret,
  type ValidSecret,
} from "./types.js";

/**
 * Matches a single trailing LF (`\n`) or CRLF (`\r\n`) appended by secret managers
 * (`wrangler secret put`, `eris`, Docker/Kubernetes secret mounts) without touching
 * intentional leading/internal whitespace.
 */
export const TRAILING_LINE_ENDING = /\r?\n$/;

/**
 * Strips at most one trailing `\n` or `\r\n` from a raw secret string.
 * Never uses `.trim()`, preserving intentional whitespace and ensuring
 * whitespace-only strings are classified as `invalid` rather than `unconfigured`.
 */
export function stripTrailingNewline(raw: string): string {
  return raw.replace(TRAILING_LINE_ENDING, "");
}

export function makeUnconfigured(envKey: string): UnconfiguredSecret {
  return {
    _tag: "Unconfigured",
    status: "unconfigured",
    envKey,
  };
}

export function makeInvalid(
  envKey: string,
  reason: string,
  issues: ReadonlyArray<HeraSchemaIssue>,
): InvalidSecret {
  return {
    _tag: "Invalid",
    status: "invalid",
    envKey,
    reason,
    issues,
  };
}

export function makeSingleIssueInvalid(
  envKey: string,
  reason: string,
  code: HeraSchemaIssueCode,
  expected: string,
  path: ReadonlyArray<PropertyKey> = [],
): InvalidSecret {
  return makeInvalid(envKey, reason, [
    {
      path,
      expected,
      code,
      message: `Expected ${expected}`,
    },
  ]);
}

export function makeValid<T>(envKey: string, decoded: T): ValidSecret<T> {
  const redacted = Redacted.make(decoded);
  const result: ValidSecret<T> = {
    _tag: "Valid",
    status: "valid",
    envKey,
    value: redacted,
  };
  Object.defineProperty(result, "toString", {
    value: () => "<redacted>",
    enumerable: false,
    configurable: true,
  });
  return result;
}

export function readRawSecret(env: EnvSource, envKey: string): RawSecretState {
  if (env === null || env === undefined || typeof env !== "object") {
    return { kind: "unconfigured" };
  }
  const raw = (env as Readonly<Record<string, unknown>>)[envKey];
  if (raw === undefined || raw === null) {
    return { kind: "unconfigured" };
  }
  if (typeof raw !== "string") {
    return { kind: "invalid_type" };
  }
  const normalized = stripTrailingNewline(raw);
  if (normalized === "") {
    return { kind: "unconfigured" };
  }
  return { kind: "present", value: normalized };
}

export function statusToEffect<T>(
  status: SecretStatus<T>,
): Effect.Effect<Redacted.Redacted<T>, HeraConfigError> {
  switch (status.status) {
    case "valid":
      return Effect.succeed(status.value);
    case "unconfigured":
      return Effect.fail(
        new HeraConfigError({
          status: "unconfigured",
          envKey: status.envKey,
          reason: `Secret ${status.envKey} is unconfigured`,
          issues: [],
        }),
      );
    case "invalid":
      return Effect.fail(
        new HeraConfigError({
          status: "invalid",
          envKey: status.envKey,
          reason: status.reason,
          issues: status.issues,
        }),
      );
  }
}

export function createSecretReader<T>(
  envKey: string,
  evaluate: (env: EnvSource) => SecretStatus<T>,
): SecretReader<T> {
  const fn = ((env: EnvSource): SecretStatus<T> => evaluate(env)) as SecretReader<T>;
  const effectForEnv = (
    env: EnvSource,
  ): Effect.Effect<Redacted.Redacted<T>, HeraConfigError> =>
    statusToEffect(evaluate(env));
  const statusEffect: Effect.Effect<SecretStatus<T>, never, HeraEnv> =
    HeraEnv.useSync((env) => evaluate(env));

  Object.defineProperties(fn, {
    envKey: {
      value: envKey,
      writable: false,
      enumerable: true,
      configurable: false,
    },
    read: {
      value: evaluate,
      writable: false,
      enumerable: true,
      configurable: false,
    },
    effect: {
      value: effectForEnv,
      writable: false,
      enumerable: true,
      configurable: false,
    },
    statusEffect: {
      value: statusEffect,
      writable: false,
      enumerable: true,
      configurable: false,
    },
    [Symbol.iterator]: {
      value() {
        return HeraEnv.use((env) => effectForEnv(env))[Symbol.iterator]();
      },
      writable: false,
      enumerable: false,
      configurable: false,
    },
  });

  return fn;
}

/**
 * Type guard narrowing `SecretStatus<T>` to `UnconfiguredSecret`.
 */
export function isUnconfigured<T>(
  status: SecretStatus<T>,
): status is UnconfiguredSecret {
  return status.status === "unconfigured";
}

/**
 * Type guard narrowing `SecretStatus<T>` to `InvalidSecret`.
 */
export function isInvalid<T>(status: SecretStatus<T>): status is InvalidSecret {
  return status.status === "invalid";
}

/**
 * Type guard narrowing `SecretStatus<T>` to `ValidSecret<T>`.
 */
export function isValid<T>(status: SecretStatus<T>): status is ValidSecret<T> {
  return status.status === "valid";
}

/**
 * Unwraps a `Redacted.Redacted<T>` secret envelope at a trusted crypto/egress boundary.
 */
export function unwrap<T>(redacted: Redacted.Redacted<T>): T {
  return Redacted.value(redacted);
}

/**
 * Exhaustive pattern matcher over the 3-state `SecretStatus<T>` union.
 */
export function match<T, R>(
  status: SecretStatus<T>,
  handlers: {
    readonly onUnconfigured: (status: UnconfiguredSecret) => R;
    readonly onInvalid: (status: InvalidSecret) => R;
    readonly onValid: (
      value: Redacted.Redacted<T>,
      status: ValidSecret<T>,
    ) => R;
  },
): R {
  switch (status.status) {
    case "unconfigured":
      return handlers.onUnconfigured(status);
    case "invalid":
      return handlers.onInvalid(status);
    case "valid":
      return handlers.onValid(status.value, status);
  }
}

/**
 * Constructs an Effect `Layer` providing `HeraEnv` from a Cloudflare `Env` record.
 */
export function layer(env: EnvSource): Layer.Layer<HeraEnv> {
  return Layer.succeed(HeraEnv, env);
}
