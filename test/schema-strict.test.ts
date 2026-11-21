import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  HeraSchema,
  type HeraFormattedIssue,
  isHeraSchemaError,
} from "../src/core/schema/index.js";

const SECRET = "sk_live_strict_secret_4242";
const Config = Schema.Struct({ known: Schema.Number });
const UNEXPECTED: HeraFormattedIssue = {
  path: ["$key"],
  code: "UnexpectedKey",
  expected: "no unexpected keys",
  message: "Unexpected key in object",
};

function failureIssues(result: Result.Result<unknown, unknown>): ReadonlyArray<HeraFormattedIssue> {
  if (Result.isSuccess(result) || !isHeraSchemaError(result.failure)) {
    throw new Error("expected a HeraSchemaError failure");
  }
  return result.failure.issues;
}

describe("strict decode", () => {
  // admits: a strict option leaking into the default wire decoders; parse options are runtime values no type sees
  it("default decoders keep stripping unknown keys", async () => {
    const input = { known: 1, typo: 2 };
    expect(HeraSchema.decodeResult(Config, input)).toEqual(Result.succeed({ known: 1 }));
    expect(HeraSchema.decodeSync(Config, input)).toEqual({ known: 1 });
    expect(await Effect.runPromise(HeraSchema.decodeUnknownEffect(Config, input))).toEqual({
      known: 1,
    });
  });

  // admits: an operator typo passing silently, or the key/value echoed into errors; runtime decode behaviour
  it("refuses an unknown key with a sanitized path and no echoed key or value", () => {
    const result = HeraSchema.decodeResultStrict(Config, { known: 1, typo: SECRET });
    expect(failureIssues(result)).toEqual([UNEXPECTED]);
    const serialized = JSON.stringify(Result.isFailure(result) ? result.failure : null);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("typo");
  });

  // admits: unknown-key issues masking the declared keys' own issues under errors: all; runtime decode behaviour
  it("reports one issue per unknown key, beside the declared keys' own issues", () => {
    const issues = failureIssues(
      HeraSchema.decodeResultStrict(Config, { known: "bad", a: 1, b: 2 }),
    );
    expect(issues.filter((i) => i.code === "UnexpectedKey")).toEqual([UNEXPECTED, UNEXPECTED]);
    expect(issues).toContainEqual(expect.objectContaining({ path: ["known"], code: "InvalidType" }));
  });

  // admits: an unknown key hidden behind a union (optional) or lost in nesting; formatter walk over runtime issues
  it("reaches unknown keys in nested, optional and array-element structs", () => {
    const Nested = Schema.Struct({
      required: Schema.Struct({ a: Schema.String }),
      optional: Schema.optional(Schema.Struct({ a: Schema.String })),
      xs: Schema.Array(Schema.Struct({ a: Schema.String })),
    });
    const issues = failureIssues(
      HeraSchema.decodeResultStrict(Nested, {
        required: { a: "x", b: SECRET },
        optional: { a: "x", b: SECRET },
        xs: [{ a: "x", b: SECRET }],
      }),
    );
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      [["required", "$key"], "UnexpectedKey"],
      [["optional", "$key"], "UnexpectedKey"],
      [["xs", 0, "$key"], "UnexpectedKey"],
    ]);
    expect(JSON.stringify(issues)).not.toContain(SECRET);
  });

  // admits: an untagged union flattening every member's issues, so one typo reads as several and a
  // sibling member's keys read as unexpected; formatter walk over runtime issues
  it("reports a union's unknown key only from the one member it otherwise matches", () => {
    const U = Schema.Struct({
      u: Schema.Union([Schema.Struct({ a: Schema.String }), Schema.Struct({ b: Schema.Number })]),
    });
    expect(failureIssues(HeraSchema.decodeResultStrict(U, { u: { a: "s", zz: SECRET } }))).toEqual([
      { ...UNEXPECTED, path: ["u", "$key"] },
    ]);
    const noMember = failureIssues(HeraSchema.decodeResultStrict(U, { u: { c: 1 } }));
    expect(noMember).toEqual([expect.objectContaining({ path: ["u"], code: "AnyOf" })]);
  });

  // admits: the AnyOf descent changing an ordinary union failure's report; formatter walk over runtime issues
  it("leaves a non-strict union failure reported as the union", () => {
    const U = Schema.Struct({ v: Schema.optional(Schema.Struct({ a: Schema.String })) });
    const issues = failureIssues(HeraSchema.decodeResultStrict(U, { v: 7 }));
    expect(issues).toEqual([expect.objectContaining({ path: ["v"], code: "AnyOf" })]);
  });

  // admits: strict mode refusing a Record's keys, which are data, not typos; runtime decode behaviour
  it("accepts arbitrary keys of a Record and valid input", () => {
    const WithMap = Schema.Struct({ known: Schema.Number, map: Schema.Record(Schema.String, Schema.Number) });
    const input = { known: 1, map: { anything: 2 } };
    expect(HeraSchema.decodeResultStrict(WithMap, input)).toEqual(Result.succeed(input));
    expect(HeraSchema.decodeResultStrict(WithMap)(input)).toEqual(Result.succeed(input));
  });

  // admits: the sync and Effect strict twins drifting from decodeResultStrict; runtime decode behaviour
  it("decodeSyncStrict throws and decodeUnknownEffectStrict fails with HeraSchemaError", async () => {
    expect(HeraSchema.decodeSyncStrict(Config)({ known: 1 })).toEqual({ known: 1 });
    let thrown: unknown;
    try {
      HeraSchema.decodeSyncStrict(Config, { known: 1, typo: SECRET });
    } catch (err) {
      thrown = err;
    }
    expect(isHeraSchemaError(thrown) && thrown.issues).toEqual([UNEXPECTED]);

    const exit = await Effect.runPromiseExit(
      HeraSchema.decodeUnknownEffectStrict(Config)({ known: 1, typo: SECRET }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).not.toContain(SECRET);
    }
  });
});
