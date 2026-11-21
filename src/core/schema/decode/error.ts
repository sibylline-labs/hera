/**
 * Value-stripped schema validation issue and error types.
 */

import * as Data from "effect/Data";

/**
 * Structural issue category emitted by `HeraSchema.formatIssues` and `HeraConfig`.
 */
export type HeraSchemaIssueCode =
  | "InvalidType"
  | "InvalidValue"
  | "MissingKey"
  | "UnexpectedKey"
  | "Filter"
  | "Encoding"
  | "Forbidden"
  | "Composite"
  | "AnyOf"
  | "OneOf"
  | "invalid_type"
  | "invalid_value"
  | "invalid_pattern"
  | "missing_key"
  | "unexpected_key"
  | "filter"
  | "encoding"
  | "forbidden"
  | "composite"
  | "any_of"
  | "one_of";

/**
 * A single value-stripped schema validation issue.
 *
 * Never contains the rejected `actual` / `input` value, unexpected keys, or dynamic filter echoes.
 */
export interface HeraSchemaIssue {
  /** Structural JSON pointer path (e.g. `["auth", "apiKey"]` or `[]` at root). */
  readonly path: ReadonlyArray<PropertyKey>;
  /** Redacted structural issue category. */
  readonly code: HeraSchemaIssueCode;
  /** Expected schema identifier, title, or structural constraint description (never contains input). */
  readonly expected: string;
  /** Safe static message describing the structural constraint (never contains input). */
  readonly message?: string | undefined;
}

/**
 * Formatted value-stripped schema validation issue with a guaranteed static `message` string.
 */
export interface HeraFormattedIssue extends HeraSchemaIssue {
  readonly message: string;
}

/**
 * Formats a `ReadonlyArray<PropertyKey>` into a human-readable structural path.
 */
export function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) {
    return "";
  }
  let out = "";
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (typeof seg === "number") {
      out += `[${String(seg)}]`;
    } else if (typeof seg === "symbol") {
      const symText = seg.description ? `Symbol(${seg.description})` : "Symbol()";
      out += out.length === 0 ? symText : `.${symText}`;
    } else {
      const str = String(seg);
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(str)) {
        out += out.length === 0 ? str : `.${str}`;
      } else {
        out += `[${JSON.stringify(str)}]`;
      }
    }
  }
  return out;
}

/**
 * Formats a summary message from an array of `HeraFormattedIssue` entries.
 */
export function formatIssueSummaryMessage(
  issues: ReadonlyArray<HeraFormattedIssue>,
): string {
  if (issues.length === 0) {
    return "Schema validation failed";
  }
  return issues
    .map((issue) => {
      const pathStr = formatIssuePath(issue.path);
      return pathStr.length > 0 ? `${pathStr}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

const BaseHeraSchemaError = Data.TaggedError("HeraSchemaError")<{
  readonly message: string;
  readonly issues: ReadonlyArray<HeraFormattedIssue>;
}>;

/**
 * Value-stripped schema validation error.
 *
 * Carries only structural `issues` and a static `message` derived from them.
 * Never retains a `.cause` reference to raw Effect `SchemaIssue.Issue` nodes.
 */
export class HeraSchemaError extends BaseHeraSchemaError {
  constructor(issues: ReadonlyArray<HeraSchemaIssue>, summary?: string) {
    const frozenIssues: ReadonlyArray<HeraFormattedIssue> = Object.freeze(
      issues.map((item) =>
        Object.freeze({
          path: Object.freeze([...item.path]),
          code: item.code,
          expected: item.expected,
          message: item.message ?? `Expected ${item.expected}`,
        }),
      ),
    );
    super({
      message: summary ?? formatIssueSummaryMessage(frozenIssues),
      issues: frozenIssues,
    });
  }

  override toJSON(): {
    readonly _tag: "HeraSchemaError";
    readonly message: string;
    readonly issues: ReadonlyArray<HeraFormattedIssue>;
  } {
    return {
      _tag: "HeraSchemaError",
      message: this.message,
      issues: this.issues,
    };
  }
}

/**
 * Type guard for `HeraSchemaError`.
 */
export function isHeraSchemaError(u: unknown): u is HeraSchemaError {
  return (
    u instanceof HeraSchemaError ||
    (typeof u === "object" &&
      u !== null &&
      "_tag" in u &&
      (u as { readonly _tag?: unknown })._tag === "HeraSchemaError" &&
      "issues" in u &&
      Array.isArray((u as { readonly issues?: unknown }).issues))
  );
}
