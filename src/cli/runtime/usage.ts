import { ErrorSlug, type HeraSchemaIssue } from "../../core/schema/index.js";
import { toErrorSlug } from "../errors/eris-error.js";

/**
 * Summarizes up to 3 `HeraSchemaIssue` entries into a single-line, value-stripped
 * diagnostic string safe for `ErisError.usage` output.
 */
export function summarizeSchemaIssues(
  issues: ReadonlyArray<HeraSchemaIssue>,
): string {
  if (issues.length === 0) {
    return "invalid argument payload";
  }
  return issues
    .slice(0, 3)
    .map((issue) => {
      const pathLabel =
        issue.path && issue.path.length > 0 ? issue.path : "<root>";
      return `${pathLabel} (${issue.code}: expected ${issue.expected})`;
    })
    .join("; ");
}

/**
 * Derives a kebab-case usage error slug for a CLI verb (`<verb>-invalid-args` or `configuredSlug`).
 */
export function deriveUsageSlug(
  verbName: string,
  configuredSlug?: ErrorSlug | string,
): ErrorSlug {
  if (configuredSlug !== undefined) {
    return toErrorSlug(configuredSlug);
  }
  const normalized = verbName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const candidate =
    normalized.length > 0 ? `${normalized}-invalid-args` : "cli-invalid-args";
  return ErrorSlug.is(candidate)
    ? candidate
    : ErrorSlug.make("cli-invalid-args");
}
