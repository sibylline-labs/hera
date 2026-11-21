/**
 * Sibylline Resource Name (`Srn`) schema, kinds vocabulary, and zero-regex parser (`parseSrn`).
 */

import * as Schema from "effect/Schema";
import { brandedId } from "../brand/factory.js";
import {
  type EnvName,
  SERVICE_NAME_PATTERN,
  type ServiceName,
} from "./primitives.js";

/**
 * Closed vocabulary of resource kinds addressable by a Sibylline Resource Name (`Srn`).
 * Covers both canonical 5-segment SRNs (`srn:sibylline:<service>:<env>:<kind>:<id>`)
 * and compact 3-segment graph locator SRNs (`srn:<kind>:<locator>`).
 */
export const SRN_KINDS = [
  "service",
  "env",
  "secret",
  "key",
  "variable",
  "gate",
  "flag",
  "seam",
  "contract",
  "resource",
  "config_key",
  "config",
  "probe",
  "actor",
  "queue",
  "workflow",
  "database",
  "bucket",
] as const;

export const SrnKindSchema = Schema.Literals(SRN_KINDS);
export type SrnKind = typeof SrnKindSchema.Type;

const SRN_KIND_GROUP = SRN_KINDS.join("|");

/**
 * Matches either:
 * 1. Canonical 5-segment SRN: `srn:sibylline:<service>:<env>:<kind>:<id>`
 * 2. Compact 3-segment graph locator SRN: `srn:<kind>:<locator>`
 */
export const SRN_PATTERN = new RegExp(
  `^srn:(?:sibylline:(?=.{1,63}:)[a-z][a-z0-9]*(?:-[a-z0-9]+)*:(?=.{1,32}:)[a-z][a-z0-9]*(?:-[a-z0-9]+)*:(?:${SRN_KIND_GROUP}):[a-zA-Z0-9._/#>-]+(?::[a-zA-Z0-9._/#>-]+)*|(?:${SRN_KIND_GROUP}):[a-zA-Z0-9._/#>-]+(?::[a-zA-Z0-9._/#>-]+)*)$`,
);

/**
 * Branded Sibylline Resource Name (`Srn`).
 * Accepts canonical 5-segment `srn:sibylline:<service>:<env>:<kind>:<id>` and
 * compact 3-segment `srn:<kind>:<locator>` strings.
 */
export const Srn = brandedId("Srn", SRN_PATTERN, {
  title: "Sibylline Resource Name",
  description:
    "Canonical 5-segment (srn:sibylline:<service>:<env>:<kind>:<id>) or compact 3-segment (srn:<kind>:<locator>) SRN",
});
export type Srn = Schema.Schema.Type<typeof Srn>;

/**
 * Structured components extracted from a branded `Srn` via `parseSrn`.
 */
export interface ParsedSrn {
  readonly service: ServiceName;
  readonly env: EnvName;
  readonly kind: SrnKind;
  readonly id: string;
  readonly raw: Srn;
}

const CANONICAL_SRN_PREFIX = "srn:sibylline:";

/**
 * Extracts `{ service, env, kind, id, raw }` from an already-validated branded `Srn`
 * using direct string slicing without re-running regex validation.
 */
export const parseSrn = (srn: Srn): ParsedSrn => {
  if (srn.startsWith(CANONICAL_SRN_PREFIX)) {
    const rest = srn.slice(CANONICAL_SRN_PREFIX.length);
    const firstColon = rest.indexOf(":");
    const secondColon = rest.indexOf(":", firstColon + 1);
    const thirdColon = rest.indexOf(":", secondColon + 1);

    const service = rest.slice(0, firstColon) as ServiceName;
    const env = rest.slice(firstColon + 1, secondColon) as EnvName;
    const kind = rest.slice(secondColon + 1, thirdColon) as SrnKind;
    const id = rest.slice(thirdColon + 1);

    return {
      service,
      env,
      kind,
      id,
      raw: srn,
    };
  }

  // Compact 3-segment graph locator SRN: `srn:<kind>:<locator>`
  const secondColon = srn.indexOf(":", 4);
  const kind = srn.slice(4, secondColon) as SrnKind;
  const locator = srn.slice(secondColon + 1);

  if (kind === "service" && SERVICE_NAME_PATTERN.test(locator)) {
    return {
      service: locator as ServiceName,
      env: "global" as EnvName,
      kind,
      id: locator,
      raw: srn,
    };
  }

  const slashIndex = locator.indexOf("/");
  if (slashIndex > 0) {
    const candidateService = locator.slice(0, slashIndex);
    const restId = locator.slice(slashIndex + 1);
    if (SERVICE_NAME_PATTERN.test(candidateService) && restId.length > 0) {
      return {
        service: candidateService as ServiceName,
        env: "global" as EnvName,
        kind,
        id: restId,
        raw: srn,
      };
    }
  }

  return {
    service: "global" as ServiceName,
    env: "global" as EnvName,
    kind,
    id: locator,
    raw: srn,
  };
};
