import type {
  HeraCliCompleteWord,
  HeraCliFlag,
  HeraCliOperand,
} from "./types.js";

interface CommonFlagOptions {
  readonly summary: string;
  readonly alias?: `-${string}` | undefined;
}

export interface StringFlagOptions extends CommonFlagOptions {
  readonly required?: boolean | undefined;
  readonly repeatable?: boolean | undefined;
  readonly choices?: readonly string[] | undefined;
  readonly maxLength?: number | undefined;
  readonly valueName?: string | undefined;
  readonly completeValue?: readonly HeraCliCompleteWord[] | undefined;
}

export interface NumberFlagOptions extends CommonFlagOptions {
  readonly required?: boolean | undefined;
  readonly int?: boolean | undefined;
  readonly valueName?: string | undefined;
  readonly completeValue?: readonly HeraCliCompleteWord[] | undefined;
}

type ChoiceOf<O> = O extends { readonly choices: readonly (infer C extends string)[] } ? C : string;

type StringValue<O> = O extends { readonly repeatable: true }
  ? readonly ChoiceOf<O>[]
  : O extends { readonly required: true }
    ? ChoiceOf<O>
    : ChoiceOf<O> | undefined;

type NumberValue<O> = O extends { readonly required: true } ? number : number | undefined;

/** A boolean switch (`--yes`): `true` when given, `false` otherwise. */
function boolean(options: CommonFlagOptions): HeraCliFlag<boolean> {
  return {
    _tag: "HeraCliFlag",
    kind: "boolean",
    summary: options.summary,
    alias: options.alias,
    required: false,
    repeatable: false,
  };
}

/** A string value flag; `repeatable` collects values in order, `choices` narrows the type. */
function string<const O extends StringFlagOptions>(options: O): HeraCliFlag<StringValue<O>> {
  return {
    _tag: "HeraCliFlag",
    kind: "string",
    summary: options.summary,
    alias: options.alias,
    required: options.required === true,
    repeatable: options.repeatable === true,
    choices: options.choices,
    maxLength: options.maxLength,
    valueName: options.valueName,
    completeValue: options.completeValue ?? options.choices,
  };
}

/** A finite number value flag (`int: true` refuses fractions). */
function number<const O extends NumberFlagOptions>(options: O): HeraCliFlag<NumberValue<O>> {
  return {
    _tag: "HeraCliFlag",
    kind: "number",
    summary: options.summary,
    alias: options.alias,
    required: options.required === true,
    repeatable: false,
    int: options.int,
    valueName: options.valueName,
    completeValue: options.completeValue,
  };
}

/** Flag constructors. A flag's map key is camelCase; its name is the kebab form (`noRedact` → `--no-redact`). */
export const flag = { boolean, string, number } as const;

interface OperandOptions {
  readonly summary: string;
  readonly complete?: readonly HeraCliCompleteWord[] | undefined;
}

function operandOf<V>(kind: HeraCliOperand["kind"], options: OperandOptions): HeraCliOperand<V> {
  return { _tag: "HeraCliOperand", kind, summary: options.summary, complete: options.complete };
}

/** Operand constructors, filled in declaration order; `rest` takes every remaining word and must be last. */
export const operand = {
  required: (options: OperandOptions): HeraCliOperand<string> => operandOf("required", options),
  optional: (options: OperandOptions): HeraCliOperand<string | undefined> =>
    operandOf("optional", options),
  rest: (options: OperandOptions): HeraCliOperand<readonly string[]> => operandOf("rest", options),
} as const;

/** `noRedact` → `--no-redact`. */
export function flagNameOf(key: string): `--${string}` {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
