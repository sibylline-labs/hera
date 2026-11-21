/**
 * Value-stripping `Schema` decode and encode operations.
 * The `*Strict` decoders refuse unknown object keys instead of stripping them.
 */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import { HeraSchemaError } from "./error.js";
import { formatIssues } from "./issue-formatter.js";

const PARSE_OPTIONS_STRIPPED: SchemaAST.ParseOptions = Object.freeze({
  errors: "all",
  reportInput: false,
});

const PARSE_OPTIONS_STRICT: SchemaAST.ParseOptions = Object.freeze({
  ...PARSE_OPTIONS_STRIPPED,
  onExcessProperty: "error",
});

/**
 * Converts a `Schema.SchemaError` into a value-stripped `HeraSchemaError`.
 */
export function toHeraSchemaError(schemaError: Schema.SchemaError): HeraSchemaError {
  return new HeraSchemaError(formatIssues(schemaError.issue));
}

function effectRunner<S extends Schema.Top>(
  schema: S,
  options: SchemaAST.ParseOptions,
): (input: unknown) => Effect.Effect<S["Type"], HeraSchemaError, S["DecodingServices"]> {
  const effectDecoder = Schema.decodeUnknownEffect(schema);
  return (input) => Effect.mapError(effectDecoder(input, options), toHeraSchemaError);
}

/**
 * Decodes an unknown input according to `schema` inside an `Effect`, failing with
 * a value-stripped `HeraSchemaError` on validation error.
 */
export function decodeUnknownEffect<S extends Schema.Top>(
  schema: S,
): (input: unknown) => Effect.Effect<S["Type"], HeraSchemaError, S["DecodingServices"]>;
export function decodeUnknownEffect<S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<S["Type"], HeraSchemaError, S["DecodingServices"]>;
export function decodeUnknownEffect<S extends Schema.Top>(
  schema: S,
  ...args: [] | [input: unknown]
):
  | ((input: unknown) => Effect.Effect<S["Type"], HeraSchemaError, S["DecodingServices"]>)
  | Effect.Effect<S["Type"], HeraSchemaError, S["DecodingServices"]> {
  const run = effectRunner(schema, PARSE_OPTIONS_STRIPPED);
  return args.length === 0 ? run : run(args[0]);
}

/**
 * `decodeUnknownEffect` that fails with an `UnexpectedKey` issue (path segment `$key`) on any
 * object key the schema does not declare, for operator-authored config.
 */
export function decodeUnknownEffectStrict<S extends Schema.Top>(
  schema: S,
): (input: unknown) => Effect.Effect<S["Type"], HeraSchemaError, S["DecodingServices"]>;
export function decodeUnknownEffectStrict<S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<S["Type"], HeraSchemaError, S["DecodingServices"]>;
export function decodeUnknownEffectStrict<S extends Schema.Top>(
  schema: S,
  ...args: [] | [input: unknown]
):
  | ((input: unknown) => Effect.Effect<S["Type"], HeraSchemaError, S["DecodingServices"]>)
  | Effect.Effect<S["Type"], HeraSchemaError, S["DecodingServices"]> {
  const run = effectRunner(schema, PARSE_OPTIONS_STRICT);
  return args.length === 0 ? run : run(args[0]);
}

/**
 * Alias for `decodeUnknownEffect` supporting both data-first `decode(schema, input)`
 * and curried `decode(schema)(input)` invocation styles.
 */
export const decode: typeof decodeUnknownEffect = decodeUnknownEffect;

function resultRunner<S extends Schema.Top>(
  schema: S,
  options: SchemaAST.ParseOptions,
): (input: unknown) => Result.Result<S["Type"], HeraSchemaError> {
  const exitDecoder = Schema.decodeUnknownExit(
    schema as S & { readonly DecodingServices: never },
  );
  return (input) => {
    const exit = exitDecoder(input, options);
    if (exit._tag === "Success") {
      return Result.succeed(exit.value);
    }
    const failReason = exit.cause.reasons.find((r) => r._tag === "Fail");
    if (failReason !== undefined && failReason._tag === "Fail") {
      return Result.fail(toHeraSchemaError(failReason.error));
    }
    return Result.fail(new HeraSchemaError([]));
  };
}

function syncRunner<S extends Schema.Top>(
  schema: S,
  options: SchemaAST.ParseOptions,
): (input: unknown) => S["Type"] {
  const resultDecoder = resultRunner(schema, options);
  return (input) => {
    const res = resultDecoder(input);
    if (Result.isFailure(res)) {
      throw res.failure;
    }
    return res.success;
  };
}

/**
 * Synchronously decodes an unknown input into a `Result.Result<S["Type"], HeraSchemaError>`
 * without throwing. Unknown object keys are stripped.
 */
export function decodeResult<S extends Schema.Top>(
  schema: S,
): (input: unknown) => Result.Result<S["Type"], HeraSchemaError>;
export function decodeResult<S extends Schema.Top>(
  schema: S,
  input: unknown,
): Result.Result<S["Type"], HeraSchemaError>;
export function decodeResult<S extends Schema.Top>(
  schema: S,
  ...args: [] | [input: unknown]
):
  | ((input: unknown) => Result.Result<S["Type"], HeraSchemaError>)
  | Result.Result<S["Type"], HeraSchemaError> {
  const run = resultRunner(schema, PARSE_OPTIONS_STRIPPED);
  return args.length === 0 ? run : run(args[0]);
}

/**
 * `decodeResult` that fails with an `UnexpectedKey` issue (path segment `$key`) on any object
 * key the schema does not declare, for operator-authored config.
 */
export function decodeResultStrict<S extends Schema.Top>(
  schema: S,
): (input: unknown) => Result.Result<S["Type"], HeraSchemaError>;
export function decodeResultStrict<S extends Schema.Top>(
  schema: S,
  input: unknown,
): Result.Result<S["Type"], HeraSchemaError>;
export function decodeResultStrict<S extends Schema.Top>(
  schema: S,
  ...args: [] | [input: unknown]
):
  | ((input: unknown) => Result.Result<S["Type"], HeraSchemaError>)
  | Result.Result<S["Type"], HeraSchemaError> {
  const run = resultRunner(schema, PARSE_OPTIONS_STRICT);
  return args.length === 0 ? run : run(args[0]);
}

/**
 * Synchronously decodes an unknown input according to `schema` or throws a
 * value-stripped `HeraSchemaError`.
 */
export function decodeSync<S extends Schema.Top>(
  schema: S,
): (input: unknown) => S["Type"];
export function decodeSync<S extends Schema.Top>(
  schema: S,
  input: unknown,
): S["Type"];
export function decodeSync<S extends Schema.Top>(
  schema: S,
  ...args: [] | [input: unknown]
): ((input: unknown) => S["Type"]) | S["Type"] {
  const run = syncRunner(schema, PARSE_OPTIONS_STRIPPED);
  return args.length === 0 ? run : run(args[0]);
}

/**
 * `decodeSync` that throws on any object key the schema does not declare.
 */
export function decodeSyncStrict<S extends Schema.Top>(
  schema: S,
): (input: unknown) => S["Type"];
export function decodeSyncStrict<S extends Schema.Top>(
  schema: S,
  input: unknown,
): S["Type"];
export function decodeSyncStrict<S extends Schema.Top>(
  schema: S,
  ...args: [] | [input: unknown]
): ((input: unknown) => S["Type"]) | S["Type"] {
  const run = syncRunner(schema, PARSE_OPTIONS_STRICT);
  return args.length === 0 ? run : run(args[0]);
}

/**
 * Alias for `decodeSync`.
 */
export const decodeUnknownSync: typeof decodeSync = decodeSync;

/**
 * Synchronously encodes a validated value back to its encoded representation,
 * throwing a value-stripped `HeraSchemaError` if encoding fails.
 */
export function encodeSync<S extends Schema.Top>(
  schema: S,
): (value: S["Type"]) => S["Encoded"];
export function encodeSync<S extends Schema.Top>(
  schema: S,
  value: S["Type"],
): S["Encoded"];
export function encodeSync<S extends Schema.Top>(
  schema: S,
  ...args: [] | [value: S["Type"]]
): ((value: S["Type"]) => S["Encoded"]) | S["Encoded"] {
  const exitEncoder = Schema.encodeUnknownExit(
    schema as S & { readonly EncodingServices: never },
  );
  const run = (value: S["Type"]): S["Encoded"] => {
    const exit = exitEncoder(value, PARSE_OPTIONS_STRIPPED);
    if (exit._tag === "Success") {
      return exit.value;
    }
    const failReason = exit.cause.reasons.find((r) => r._tag === "Fail");
    if (failReason !== undefined && failReason._tag === "Fail") {
      throw toHeraSchemaError(failReason.error);
    }
    throw new HeraSchemaError([]);
  };
  return args.length === 0 ? run : run(args[0]);
}
