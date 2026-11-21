import { describe, expect, test } from "vitest";
import {
  type HeraCliVerbNode,
  composeProgram,
  defineVerb,
  definePlugin,
  flag,
  operand,
  parseGlobals,
  route,
  tokenize,
} from "../src/cli/manifest/index.js";
import { fixtureProgram } from "./fixtures/cli-manifest/manifest.js";

const never = (): never => {
  throw new Error("not loaded in this test");
};

const program = composeProgram({
  name: "tool",
  builtins: false,
  plugins: [
    definePlugin({
      name: "p",
      commands: {
        run: defineVerb({
          summary: "Run",
          flags: {
            yes: flag.boolean({ summary: "Skip the prompt", alias: "-y" }),
            tag: flag.string({ summary: "A tag", repeatable: true }),
            name: flag.string({ summary: "A name" }),
          },
          operands: { first: operand.required({ summary: "First" }), rest: operand.rest({ summary: "Rest" }) },
          load: never,
        }),
      },
    }),
  ],
});
const run = program.nodes.get("run") as HeraCliVerbNode;

describe("tokenize: the strict argv grammar", () => {
  // admits: algorithmic: a grammar change (value joining, repeatables, aliases, `--`, dash operands) that
  // decodes a line differently; argv content is invisible to types.
  test("decodes values, repeatables, aliases, -- and dash-led operands", () => {
    expect(tokenize("tool", run, ["a", "--tag", "x", "--tag=y", "-y", "--name=-z", "-", "-5", "--", "--not-a-flag"])).toEqual({
      _tag: "Args",
      raw: { yes: true, tag: ["x", "y"], name: "-z", first: "a", rest: ["-", "-5", "--not-a-flag"] },
    });
  });

  // admits: algorithmic: a refusal kind lost or re-slugged (unknown flag accepted silently, a dropped
  // duplicate value, an operand overflow) — each is a runtime argv fact.
  test.each([
    [["a", "--bogus"], "p-unknown-flag", "unknown flag --bogus"],
    [["a", "--name", "x", "--name", "y"], "p-duplicate-flag", "--name is given twice"],
    [["a", "--name"], "p-flag-missing-value", "--name needs a value"],
    [["a", "--name", "--yes"], "p-flag-missing-value", "--name needs a value"],
    [["a", "--yes=1"], "p-unexpected-value", "--yes takes no value"],
    [[], "p-missing-arg", "missing <first>"],
  ])("refuses %j with %s", (argv, slug, what) => {
    const t = tokenize("tool", { ...run, spec: { ...run.spec, slugPrefix: "p" } }, argv);
    expect(t._tag).toBe("Refuse");
    if (t._tag !== "Refuse") return;
    expect(t.refusal.slug).toBe(slug);
    expect(t.refusal.what).toContain(what);
  });

  // admits: algorithmic: help losing to a refusal; a user asking for help must get it whatever else is wrong.
  test("--help before -- wins over a refusal; after -- it is an operand", () => {
    expect(tokenize("tool", run, ["--bogus", "--help"])._tag).toBe("Help");
    const after = tokenize("tool", run, ["a", "--", "--help"]);
    expect(after).toEqual({ _tag: "Args", raw: { yes: false, tag: [], first: "a", rest: ["--help"] } });
  });

  // admits: algorithmic: an extra operand accepted when no rest operand is declared.
  test("a word past the last operand is refused", () => {
    const issue = fixtureProgram.nodes.get("skills lint") as HeraCliVerbNode;
    const t = tokenize("fixture", issue, ["a", "b"]);
    expect(t._tag === "Refuse" && t.refusal.slug).toBe("skills-unexpected-arg");
  });
});

describe("globals and routing", () => {
  // admits: algorithmic: the global pre-pass dropping or mis-reading --output/--json, which changes every verb's rendering.
  test("--output and --json are read before -- and removed", () => {
    expect(parseGlobals("tool", ["run", "--json", "a"])).toEqual({ _tag: "Ok", mode: "json", argv: ["run", "a"] });
    expect(parseGlobals("tool", ["--output=text", "run", "--", "--json"])).toEqual({
      _tag: "Ok",
      mode: "text",
      argv: ["run", "--", "--json"],
    });
    const bad = parseGlobals("tool", ["--output", "yaml"]);
    expect(bad._tag === "Refuse" && bad.refusal.slug).toBe("output-format-unknown");
    const clash = parseGlobals("tool", ["--json", "--output", "text"]);
    expect(clash._tag === "Refuse" && clash.refusal.slug).toBe("output-format-conflict");
  });

  // admits: algorithmic: an unknown command routed somewhere, or a bare group not answering help.
  test("routes groups, answers a bare group with help, refuses an unknown word", () => {
    expect(route(fixtureProgram, ["yak"])).toMatchObject({ _tag: "Help", node: { path: "yak" } });
    expect(route(fixtureProgram, ["yak", "issue", "--summary", "x"])).toMatchObject({ _tag: "Verb", rest: ["--summary", "x"] });
    const r = route(fixtureProgram, ["yak", "nope"]);
    expect(r._tag === "Refuse" && r.refusal.slug).toBe("yak-unknown-command");
    expect(route(fixtureProgram, ["--version"])._tag).toBe("Version");
  });
});
