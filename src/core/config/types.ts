/**
 * Configuration & 3-state Eris secret types.
 */

import { Context, type Effect, type Redacted, type Schema } from "effect";
import type { HeraSchemaIssue } from "../schema/index.js";

/**
 * Raw Cloudflare `Env` record or arbitrary key-value environment source.
 */
export type EnvSource = Readonly<Record<string, unknown>> | null | undefined;

/**
 * Secret binding is absent (`undefined`, `null`, missing property) or empty `""`
 * after stripping a single trailing `\r?\n$`.
 */
export interface UnconfiguredSecret {
  readonly _tag: "Unconfigured";
  readonly status: "unconfigured";
  readonly envKey: string;
}

/**
 * Secret binding is present and non-empty after `\r?\n$` normalization,
 * but failed schema, hex-key, or keyring validation.
 * Never echoes the rejected secret value in `reason` or `issues`.
 */
export interface InvalidSecret {
  readonly _tag: "Invalid";
  readonly status: "invalid";
  readonly envKey: string;
  readonly reason: string;
  readonly issues: ReadonlyArray<HeraSchemaIssue>;
}

/**
 * Secret binding is present, normalized, validated, and wrapped in an Effect `Redacted<T>` envelope.
 */
export interface ValidSecret<T> {
  readonly _tag: "Valid";
  readonly status: "valid";
  readonly envKey: string;
  readonly value: Redacted.Redacted<T>;
}

/**
 * 3-state Eris secret status, allowing boundary routes to distinguish
 * `503 *_unconfigured` from `503 *_invalid_config` and valid `Redacted<T>` values.
 */
export type SecretStatus<T> = UnconfiguredSecret | InvalidSecret | ValidSecret<T>;

/**
 * Typed configuration error raised when a `SecretReader` is evaluated as an `Effect`
 * and the underlying secret is `unconfigured` or `invalid`.
 * Maps cleanly onto `503 *_unconfigured` vs `503 *_invalid_config` without leaking secret values.
 */
export class HeraConfigError extends Error {
  readonly _tag = "HeraConfigError" as const;
  override readonly name = "HeraConfigError" as const;
  readonly status: "unconfigured" | "invalid";
  readonly envKey: string;
  readonly reason: string;
  readonly issues: ReadonlyArray<HeraSchemaIssue>;
  readonly httpStatus = 503 as const;
  readonly errorCode: string;

  constructor(params: {
    readonly status: "unconfigured" | "invalid";
    readonly envKey: string;
    readonly reason: string;
    readonly issues?: ReadonlyArray<HeraSchemaIssue> | undefined;
  }) {
    super(params.reason);
    this.status = params.status;
    this.envKey = params.envKey;
    this.reason = params.reason;
    this.issues = params.issues ?? [];
    const prefix = params.envKey.toLowerCase();
    this.errorCode =
      params.status === "unconfigured"
        ? `${prefix}_unconfigured`
        : `${prefix}_invalid_config`;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): {
    readonly _tag: "HeraConfigError";
    readonly status: "unconfigured" | "invalid";
    readonly envKey: string;
    readonly errorCode: string;
    readonly httpStatus: 503;
    readonly reason: string;
    readonly issues: ReadonlyArray<HeraSchemaIssue>;
  } {
    return {
      _tag: this._tag,
      status: this.status,
      envKey: this.envKey,
      errorCode: this.errorCode,
      httpStatus: this.httpStatus,
      reason: this.reason,
      issues: this.issues,
    };
  }
}

/**
 * Effect v4 `Context.Service` tag providing the raw Cloudflare `Env` record to `HeraConfig` readers.
 */
export class HeraEnv extends Context.Service<HeraEnv, EnvSource>()(
  "@sibylline-labs/hera/HeraEnv",
) {}

/**
 * Dual callable / Effect-yieldable secret reader.
 *
 * - Call directly: `reader(env)` or `reader.read(env)` -> `SecretStatus<T>`
 * - Run as Effect with explicit `env`: `reader.effect(env)` -> `Effect<Redacted<T>, HeraConfigError>`
 * - Yield inside `Effect.gen` when `HeraEnv` is in context: `const secret = yield* reader`
 */
export interface SecretReader<T> {
  (env: EnvSource): SecretStatus<T>;
  readonly envKey: string;
  readonly read: (env: EnvSource) => SecretStatus<T>;
  readonly effect: (
    env: EnvSource,
  ) => Effect.Effect<Redacted.Redacted<T>, HeraConfigError>;
  readonly statusEffect: Effect.Effect<SecretStatus<T>, never, HeraEnv>;
  [Symbol.iterator](): Effect.EffectIterator<
    Effect.Effect<Redacted.Redacted<T>, HeraConfigError, HeraEnv>
  >;
}

/**
 * Single versioned key entry inside a `Keyring`.
 */
export interface KeyringEntry {
  readonly version: string;
  readonly versionNumber: number;
  readonly key: Uint8Array;
}

/**
 * A single unversioned key read as a one-entry keyring while the keyring secret is unset
 * (`HeraConfig.keyring` `legacy` option). `version` is `v<N>` with `N >= 1`.
 */
export interface KeyringLegacyOptions {
  readonly key: string;
  readonly encoding: "base64";
  readonly version: string;
}

/**
 * Options for `HeraConfig.keyring`. A `legacy` fallback needs `byteLength`: its value has no
 * sibling entries to infer a length from.
 */
export type KeyringOptions =
  | {
      readonly byteLength?: number | undefined;
      readonly legacy?: undefined;
    }
  | {
      readonly byteLength: number;
      readonly legacy: KeyringLegacyOptions;
    };

/**
 * Schema constraint for `HeraConfig.secret` readers.
 */
export type SecretSchema = Schema.Top & { readonly DecodingServices: never };

/**
 * Internal pre-validation state of an environment secret slot.
 */
export type RawSecretState =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "invalid_type" }
  | { readonly kind: "present"; readonly value: string };
