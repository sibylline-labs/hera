/**
 * Value-stripping `SchemaIssue.Issue` walker and formatter.
 */

import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import {
  describeAstExpected,
  describeFilterExpected,
  readStaticAnnotation,
  sanitizePointerPath,
} from "./ast-describer.js";
import {
  type HeraFormattedIssue,
  type HeraSchemaError,
  isHeraSchemaError,
} from "./error.js";

/**
 * Recursively collects value-stripped `HeraFormattedIssue` items from an Effect `SchemaIssue.Issue`.
 */
export function collectIssues(
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  parentAst?: SchemaAST.AST,
): ReadonlyArray<HeraFormattedIssue> {
  switch (issue._tag) {
    case "Pointer": {
      if (issue.issue._tag === "UnexpectedKey") {
        // The key is input-derived and undeclared, so it renders as `$key`.
        return collectIssues(issue.issue, [...path, "$key"], parentAst);
      }
      const { sanitized, childAst } = sanitizePointerPath(issue.path, parentAst);
      return collectIssues(issue.issue, [...path, ...sanitized], childAst);
    }

    case "Composite": {
      const compositeAst = issue.ast;
      const results: Array<HeraFormattedIssue> = [];
      for (let i = 0; i < issue.issues.length; i++) {
        const child = issue.issues[i];
        if (!child) continue;
        results.push(...collectIssues(child, path, compositeAst));
      }
      if (results.length > 0) {
        return results;
      }
      const expected = describeAstExpected(compositeAst);
      return [
        {
          path,
          code: "Composite",
          expected,
          message: `Expected ${expected}`,
        },
      ];
    }

    case "Filter": {
      const expected = describeFilterExpected(issue.filter, parentAst);
      const inner = issue.issue;
      if (inner._tag === "InvalidValue") {
        return [
          {
            path,
            code: "Filter",
            expected,
            message: `Expected ${expected}`,
          },
        ];
      }
      const nested = collectIssues(inner, path, parentAst);
      return nested.map((item) => ({
        path: item.path,
        code: "Filter",
        expected: item.expected === "valid value" ? expected : item.expected,
        message:
          item.expected === "valid value" ? `Expected ${expected}` : item.message,
      }));
    }

    case "Encoding": {
      const inner = issue.issue;
      if (inner._tag === "InvalidValue" || inner._tag === "Forbidden") {
        const expected = describeAstExpected(issue.ast);
        return [
          {
            path,
            code: "Encoding",
            expected,
            message: `Encoding failed for ${expected}`,
          },
        ];
      }
      const nested = collectIssues(inner, path, issue.ast);
      return nested.map((item) => ({
        path: item.path,
        code: item.code === "InvalidValue" ? "Encoding" : item.code,
        expected: item.expected,
        message: item.message,
      }));
    }

    case "MissingKey": {
      const expected =
        readStaticAnnotation(issue.annotations) ??
        (parentAst !== undefined ? describeAstExpected(parentAst) : "required property");
      return [
        {
          path,
          code: "MissingKey",
          expected,
          message: "Missing required key",
        },
      ];
    }

    case "UnexpectedKey": {
      return [
        {
          path,
          code: "UnexpectedKey",
          expected: "no unexpected keys",
          message: "Unexpected key in object",
        },
      ];
    }

    case "InvalidType": {
      const expected = describeAstExpected(issue.ast);
      return [
        {
          path,
          code: "InvalidType",
          expected,
          message: `Expected ${expected}`,
        },
      ];
    }

    case "InvalidValue": {
      const expected =
        readStaticAnnotation(issue.annotations) ??
        (parentAst !== undefined ? describeAstExpected(parentAst) : "valid value");
      return [
        {
          path,
          code: "InvalidValue",
          expected,
          message: `Expected ${expected}`,
        },
      ];
    }

    case "Forbidden": {
      const expected =
        readStaticAnnotation(issue.annotations) ??
        (parentAst !== undefined ? describeAstExpected(parentAst) : "permitted operation");
      return [
        {
          path,
          code: "Forbidden",
          expected,
          message: `Forbidden operation (${expected})`,
        },
      ];
    }

    case "AnyOf": {
      // When exactly one member failed on unknown keys alone, the input is that member plus typos:
      // report the keys, not the union. Default decode strips keys, so never lands here.
      const onlyUnknownKeys = issue.issues
        .map((child) => collectIssues(child, path, issue.ast))
        .filter((items) => items.length > 0 && items.every((item) => item.code === "UnexpectedKey"));
      if (onlyUnknownKeys.length === 1 && onlyUnknownKeys[0] !== undefined) {
        return onlyUnknownKeys[0];
      }
      const expected = describeAstExpected(issue.ast);
      return [
        {
          path,
          code: "AnyOf",
          expected,
          message: `Expected any of: ${expected}`,
        },
      ];
    }

    case "OneOf": {
      const expected = describeAstExpected(issue.ast);
      return [
        {
          path,
          code: "OneOf",
          expected,
          message: `Expected exactly one of: ${expected}`,
        },
      ];
    }
  }
}

/**
 * Strips all runtime values from a `SchemaIssue.Issue`, `Schema.SchemaError`, or `HeraSchemaError`
 * and returns a flat list of structural `HeraFormattedIssue` items.
 */
export function formatIssues(
  issueOrError: SchemaIssue.Issue | Schema.SchemaError | HeraSchemaError,
): ReadonlyArray<HeraFormattedIssue> {
  if (isHeraSchemaError(issueOrError)) {
    return issueOrError.issues;
  }
  const rootIssue: SchemaIssue.Issue = Schema.isSchemaError(issueOrError)
    ? issueOrError.issue
    : issueOrError;
  return collectIssues(rootIssue, []);
}
