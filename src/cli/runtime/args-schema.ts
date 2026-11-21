import * as Schema from "effect/Schema";
import type {
  HeraCliFlag,
  HeraCliOperand,
  HeraCliVerbNode,
} from "../manifest/types.js";

function scalarOf(spec: HeraCliFlag): Schema.Top {
  if (spec.kind === "boolean") return Schema.Boolean;
  if (spec.kind === "number") {
    return spec.int === true ? Schema.FiniteFromString.check(Schema.isInt()) : Schema.FiniteFromString;
  }
  if (spec.choices !== undefined) return Schema.Literals(spec.choices);
  return spec.maxLength !== undefined ? Schema.String.check(Schema.isMaxLength(spec.maxLength)) : Schema.String;
}

function flagSchema(spec: HeraCliFlag): Schema.Top {
  if (spec.repeatable) return Schema.Array(scalarOf(spec));
  if (spec.kind === "boolean" || spec.required) return scalarOf(spec);
  return Schema.optional(scalarOf(spec));
}

function operandSchema(spec: HeraCliOperand): Schema.Top {
  if (spec.kind === "rest") return Schema.Array(Schema.String);
  return spec.kind === "required" ? Schema.String : Schema.optional(Schema.String);
}

/**
 * The schema a composed verb's tokenized argv decodes against, derived from the same flag and
 * operand declarations its help and completion read. Extension flags are included, so one decode
 * checks the whole line.
 */
export function argsSchemaOf(node: HeraCliVerbNode): Schema.Struct<Record<string, Schema.Top>> {
  const fields: Record<string, Schema.Top> = {};
  for (const f of node.flags) fields[f.key] = flagSchema(f.spec);
  for (const o of node.operands) fields[o.key] = operandSchema(o.spec);
  return Schema.Struct(fields);
}

/** The decoded keys a verb's own handler reads (extension flags excluded). */
export function ownKeysOf(node: HeraCliVerbNode): readonly string[] {
  return [...node.flags.filter((f) => f.extension === undefined).map((f) => f.key), ...node.operands.map((o) => o.key)];
}

/** The decoded keys one extension's hooks read. */
export function extensionKeysOf(node: HeraCliVerbNode, plugin: string): readonly string[] {
  return node.flags.filter((f) => f.extension === plugin).map((f) => f.key);
}

export function pick(record: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(record, key)) out[key] = record[key];
  return out;
}
