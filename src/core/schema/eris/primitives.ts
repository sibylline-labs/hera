/**
 * Eris branded nominal primitives (`ServiceName`, `EnvName`, `KeyName`, `GcpProjectId`,
 * `LogfireProject`, `ErrorSlug`).
 */

import type * as Schema from "effect/Schema";
import { brandedId } from "../brand/factory.js";

/**
 * Canonical Eris environment names. Custom preview/regional kebab-case environments
 * matching `ENV_NAME_PATTERN` are also valid `EnvName` values.
 */
export const CANONICAL_ENV_NAMES = [
  "local",
  "dev",
  "staging",
  "prod",
  "prod-uc1",
  "preview",
  "test",
  "global",
] as const;

export const SERVICE_NAME_PATTERN =
  /^(?=.{1,63}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const ENV_NAME_PATTERN = /^(?=.{1,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const KEY_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** The Logfire SDK's `PROJECT_NAME_PATTERN`, bounded by the 50-char limit its `sanitize_project_name` states. */
export const LOGFIRE_PROJECT_PATTERN = /^(?=.{1,50}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ERROR_SLUG_PATTERN = /^(?=.{3,128}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

/**
 * Branded kebab-case service identifier (`^[a-z][a-z0-9-]{0,62}$`, no leading/trailing/double hyphens).
 */
export const ServiceName = brandedId("ServiceName", SERVICE_NAME_PATTERN, {
  title: "Service Name",
  description: "Kebab-case Eris service identifier (1..63 chars)",
});
export type ServiceName = Schema.Schema.Type<typeof ServiceName>;

/**
 * Branded Eris environment identifier (`local`, `dev`, `staging`, `prod`, `prod-uc1`, `preview`, `test`, etc.).
 */
export const EnvName = brandedId("EnvName", ENV_NAME_PATTERN, {
  title: "Environment Name",
  description: "Canonical or patterned Eris environment name (1..32 chars)",
});
export type EnvName = Schema.Schema.Type<typeof EnvName>;

/**
 * Branded `SCREAMING_SNAKE_CASE` config/secret key identifier (`^[A-Z][A-Z0-9_]{0,127}$`).
 */
export const KeyName = brandedId("KeyName", KEY_NAME_PATTERN, {
  title: "Config/Secret Key Name",
  description: "SCREAMING_SNAKE_CASE config or secret key identifier (1..128 chars)",
});
export type KeyName = Schema.Schema.Type<typeof KeyName>;

/**
 * Branded GCP project identifier (`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`, 6..30 chars).
 */
export const GcpProjectId = brandedId("GcpProjectId", GCP_PROJECT_ID_PATTERN, {
  title: "GCP Project ID",
  description: "Google Cloud project identifier (6..30 lowercase chars, digits, hyphens)",
});
export type GcpProjectId = Schema.Schema.Type<typeof GcpProjectId>;

/**
 * Branded Logfire project name (lowercase alphanumerics, single inner hyphens, 1..50 chars), as in
 * `envs.<env>.logfire.project`. Not a GCP project id: `dev` is a valid Logfire project.
 */
export const LogfireProject = brandedId("LogfireProject", LOGFIRE_PROJECT_PATTERN, {
  title: "Logfire Project",
  description: "Logfire project name (1..50 lowercase alphanumerics, single inner hyphens)",
  examples: ["billing-api", "dev"],
});
export type LogfireProject = Schema.Schema.Type<typeof LogfireProject>;

/**
 * Branded kebab-case diagnostic error slug (e.g. `key-unregistered`, `seam-undeclared`, `fetch-timeout`).
 */
export const ErrorSlug = brandedId("ErrorSlug", ERROR_SLUG_PATTERN, {
  title: "Error Slug",
  description: "Kebab-case diagnostic error code slug (<family>-<reason>)",
});
export type ErrorSlug = Schema.Schema.Type<typeof ErrorSlug>;
