/**
 * Static AST label extraction and pointer-path sanitization helpers.
 *
 * Never reads dynamic filter messages or untrusted runtime values.
 */

import type * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";

/**
 * Extracts a safe static string annotation (`expected`, `identifier`, or `title`)
 * from an annotations record without ever reading `message` (which in custom
 * filters can be dynamically synthesized from the rejected value).
 */
export function readStaticAnnotation(
  annotations: Schema.Annotations.Annotations | undefined,
): string | undefined {
  if (!annotations) {
    return undefined;
  }
  if (typeof annotations.expected === "string" && annotations.expected.length > 0) {
    return annotations.expected;
  }
  if (typeof annotations.identifier === "string" && annotations.identifier.length > 0) {
    return annotations.identifier;
  }
  if (typeof annotations.title === "string" && annotations.title.length > 0) {
    return annotations.title;
  }
  return undefined;
}

/**
 * Inspects static `AST.checks` for a static annotation (`expected`, `identifier`, `title`).
 */
export function describeAstChecks(
  checks: ReadonlyArray<SchemaAST.Check<any>> | undefined,
): string | undefined {
  if (!checks || checks.length === 0) {
    return undefined;
  }
  for (let i = checks.length - 1; i >= 0; i--) {
    const check = checks[i];
    if (!check) continue;
    const ann = readStaticAnnotation(check.annotations);
    if (ann !== undefined) {
      return ann;
    }
  }
  return undefined;
}

/**
 * Derives a safe static expectation string from a `SchemaAST.AST` node.
 * Never touches runtime input values.
 */
export function describeAstExpected(ast: SchemaAST.AST): string {
  const fromAnnotation = readStaticAnnotation(ast.annotations);
  if (fromAnnotation !== undefined) {
    return fromAnnotation;
  }
  const fromChecks = describeAstChecks(ast.checks);
  if (fromChecks !== undefined) {
    return fromChecks;
  }
  switch (ast._tag) {
    case "String":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    case "BigInt":
      return "bigint";
    case "Symbol":
      return "symbol";
    case "Null":
      return "null";
    case "Undefined":
      return "undefined";
    case "Void":
      return "void";
    case "Never":
      return "never";
    case "Unknown":
      return "unknown";
    case "Any":
      return "any";
    case "ObjectKeyword":
      return "object";
    case "UniqueSymbol":
      return typeof ast.symbol.description === "string"
        ? `Symbol(${ast.symbol.description})`
        : "symbol";
    case "Literal":
      return typeof ast.literal === "string"
        ? JSON.stringify(ast.literal)
        : String(ast.literal);
    case "Enum":
      return ast.enums.map(([, val]) => JSON.stringify(val)).join(" | ") || "enum";
    case "TemplateLiteral":
      return "template literal";
    case "Arrays":
      return "array";
    case "Objects":
      return "object";
    case "Union": {
      const parts = ast.types.map((member) => describeAstExpected(member));
      return parts.length > 0 ? parts.join(" | ") : "never";
    }
    case "Suspend":
      return describeAstExpected(ast.thunk());
    case "Declaration":
      return "Declaration";
  }
}

/**
 * Derives a safe static expectation string from a `SchemaAST.Filter<any>`.
 */
export function describeFilterExpected(
  filter: SchemaAST.Filter<any>,
  fallbackAst?: SchemaAST.AST,
): string {
  const fromFilter = readStaticAnnotation(filter.annotations);
  if (fromFilter !== undefined) {
    return fromFilter;
  }
  if (fallbackAst !== undefined) {
    return describeAstExpected(fallbackAst);
  }
  return "constraint satisfaction";
}

/**
 * Advances through `parentAst` along a `Pointer` segment and decides whether
 * the segment is a static schema key/index or a dynamic untrusted record key.
 *
 * Under an `Objects` AST, any property key that is NOT declared in
 * `parentAst.propertySignatures` came from the untrusted input object
 * (e.g. a `Schema.Record` key or an excess property) and is replaced with `"$key"`.
 */
export function sanitizePointerPath(
  pointerPath: ReadonlyArray<PropertyKey>,
  parentAst: SchemaAST.AST | undefined,
): {
  readonly sanitized: ReadonlyArray<PropertyKey>;
  readonly childAst: SchemaAST.AST | undefined;
} {
  const sanitized: Array<PropertyKey> = [];
  let currentAst = parentAst;

  for (let i = 0; i < pointerPath.length; i++) {
    const seg = pointerPath[i]!;
    if (currentAst !== undefined) {
      const unwrapped =
        currentAst._tag === "Suspend" ? currentAst.thunk() : currentAst;
      if (unwrapped._tag === "Objects") {
        const matchedProp = unwrapped.propertySignatures.find(
          (ps) => ps.name === seg,
        );
        if (matchedProp !== undefined) {
          sanitized.push(seg);
          currentAst = matchedProp.type;
          continue;
        }
        sanitized.push("$key");
        const firstIndexSig = unwrapped.indexSignatures[0];
        currentAst =
          firstIndexSig !== undefined ? firstIndexSig.type : undefined;
        continue;
      }
      if (unwrapped._tag === "Arrays") {
        if (typeof seg === "number") {
          sanitized.push(seg);
          const elemAst =
            seg < unwrapped.elements.length
              ? unwrapped.elements[seg]
              : unwrapped.rest[0];
          currentAst = elemAst;
          continue;
        }
        sanitized.push("$index");
        currentAst = unwrapped.rest[0] ?? unwrapped.elements[0];
        continue;
      }
    }
    sanitized.push(seg);
    currentAst = undefined;
  }

  return { sanitized, childAst: currentAst };
}
