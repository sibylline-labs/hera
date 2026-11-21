/**
 * Branded nominal ID `Schema` factory.
 */

import type * as Brand from "effect/Brand";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeSync } from "../decode/decoders.js";

/**
 * Optional metadata annotations attached to a branded ID schema.
 */
export interface BrandedIdMeta {
  /** Schema identifier (defaults to `brand`). */
  readonly identifier?: string;
  /** Human-readable title for the ID type. */
  readonly title?: string;
  /** Documentation description for the ID type. */
  readonly description?: string;
  /** Example valid ID strings. */
  readonly examples?: ReadonlyArray<string>;
}

/**
 * A nominal branded string schema produced by `HeraSchema.brandedId(brand, pattern, meta)`
 * that works directly in `Schema.Struct`, `Schema.Array`, etc., and exposes value-stripped
 * `.make(input)`, `.is(input)`, `.option(input)`, `.brandName`, and `.pattern` helpers.
 */
export interface BrandedIdSchema<B extends string>
  extends Schema.brand<Schema.String, B> {
  /** Nominal brand identifier. */
  readonly brandName: B;
  /** Validation regex enforced by this branded ID schema. */
  readonly pattern: RegExp;
  /**
   * Synchronously validates and brands `input`, throwing a value-stripped
   * `HeraSchemaError` on invalid input.
   */
  readonly make: (input: string, options?: Schema.MakeOptions) => string & Brand.Brand<B>;
  /**
   * Type guard returning `true` when `u` is a valid branded ID of type `B`.
   */
  readonly is: (u: unknown) => u is string & Brand.Brand<B>;
  /**
   * Returns `Option.some(branded)` when `u` is a valid ID of type `B`, or `Option.none()`.
   */
  readonly option: (u: unknown) => Option.Option<string & Brand.Brand<B>>;
}

/**
 * Constructs a branded nominal string `Schema` validated against `pattern`.
 */
export function brandedId<const B extends string>(
  brandName: B,
  pattern: RegExp,
  meta?: BrandedIdMeta,
): BrandedIdSchema<B> {
  const identifier = meta?.identifier ?? brandName;
  const title = meta?.title ?? brandName;
  const expected = `${identifier} matching ${String(pattern)}`;

  const checkAnnotations: Schema.Annotations.Filter = {
    identifier,
    title,
    expected,
    ...(meta?.description !== undefined ? { description: meta.description } : {}),
  };

  const schemaAnnotations: Schema.Annotations.Bottom<
    string & Brand.Brand<B>,
    readonly []
  > = {
    identifier,
    title,
    expected,
    ...(meta?.description !== undefined ? { description: meta.description } : {}),
    ...(meta?.examples !== undefined
      ? { examples: meta.examples as ReadonlyArray<string & Brand.Brand<B>> }
      : {}),
  };

  const baseSchema = Schema.String.pipe(
    Schema.check(Schema.isPattern(pattern, checkAnnotations)),
    Schema.brand<B>(brandName as never),
  ).annotate(schemaAnnotations);

  const isGuard = (u: unknown): u is string & Brand.Brand<B> =>
    typeof u === "string" && pattern.test(u);

  const makeFn = (input: string): string & Brand.Brand<B> => {
    if (typeof input === "string" && pattern.test(input)) {
      return input as string & Brand.Brand<B>;
    }
    return decodeSync(baseSchema, input);
  };

  const optionFn = (u: unknown): Option.Option<string & Brand.Brand<B>> =>
    isGuard(u) ? Option.some(u) : Option.none();

  Object.defineProperties(baseSchema, {
    brandName: {
      value: brandName,
      enumerable: true,
      configurable: false,
      writable: false,
    },
    pattern: {
      value: pattern,
      enumerable: true,
      configurable: false,
      writable: false,
    },
    make: {
      value: makeFn,
      enumerable: false,
      configurable: true,
      writable: false,
    },
    makeOption: {
      value: optionFn,
      enumerable: false,
      configurable: true,
      writable: false,
    },
    is: {
      value: isGuard,
      enumerable: true,
      configurable: false,
      writable: false,
    },
    option: {
      value: optionFn,
      enumerable: true,
      configurable: false,
      writable: false,
    },
  });

  return baseSchema as unknown as BrandedIdSchema<B>;
}
