import { describe, expect, test } from "vitest";
import {
  HeraCliManifestError,
  type HeraCliNode,
  composeProgram,
  defineExtension,
  defineGroup,
  definePlugin,
  defineVerb,
  docsJson,
  flag,
  helpJson,
  helpText,
  operand,
} from "../src/cli/manifest/index.js";
import { fixtureProgram, yakPlugin } from "./fixtures/cli-manifest/manifest.js";

const node = (path: string): HeraCliNode => fixtureProgram.nodes.get(path) as HeraCliNode;
const never = (): never => {
  throw new Error("not loaded");
};

describe("help derived from the one declaration", () => {
  // admits: algorithmic: a flag reaching `--help --output json` without its declared summary (the eris-help/1
  // gap this host closes); output content is invisible to types.
  test("every flag of every path in eris-help/1 carries a non-empty summary from its spec", () => {
    const docs = docsJson(fixtureProgram);
    expect(docs.map((d) => d.path)).toContain("yak issue");
    for (const doc of docs) {
      expect(doc.schema).toBe("eris-help/1");
      for (const f of doc.flags) expect(f.summary?.length ?? 0).toBeGreaterThan(0);
    }
    const issue = helpJson(fixtureProgram, node("yak issue"));
    expect(issue.flags.find((f) => f.name === "--summary")?.summary).toBe("One-line title of the report (required)");
    expect(issue.flags.find((f) => f.name === "--repo")).toMatchObject({ arg: "value", repeatable: true });
    expect(issue.flags.find((f) => f.name === "--no-redact")).toMatchObject({ alias: "-n" });
    expect(issue.flags.find((f) => f.name === "--format")?.arg).toBe("md|txt");
  });

  // admits: algorithmic: an extension's flag missing from the target's help (the string-patched help it replaces).
  test("an extension's flags join its target's prose help and help-json", () => {
    expect(helpText(fixtureProgram, node("yak issue"))).toContain(
      "--project <id|name>   Linear project id or near-exact name to file into (<= 200 chars)",
    );
    expect(helpJson(fixtureProgram, node("yak issue")).flags.map((f) => f.name)).toContain("--project");
  });

  // admits: algorithmic: a group or the top level listing the wrong commands or usage.
  test("groups list their commands; the top level lists globals", () => {
    expect(helpJson(fixtureProgram, node("yak"))).toMatchObject({
      usage: "fixture yak <command>",
      commands: [{ name: "issue", summary: "File a harness issue" }],
    });
    const top = helpJson(fixtureProgram, node(""));
    expect(top.commands.map((c) => c.name)).toEqual(["completion", "docs", "yak", "skills"]);
    expect(top.flags.map((f) => f.name)).toEqual(["--output", "--json", "--version", "--help"]);
    expect(helpText(fixtureProgram, node("skills lint"))).toContain("Usage: fixture skills lint [dir] [flags]");
  });
});

describe("composition refuses an inconsistent manifest", () => {
  const verb = (flags: Parameters<typeof defineVerb>[0]["flags"] = {}) => defineVerb({ summary: "v", flags, load: never });

  // admits: algorithmic: a manifest that would emit broken help, an unrunnable verb or a script that runs code
  // in the user's shell; each is a data fact composition must check.
  test.each([
    ["a duplicate plugin", () => [yakPlugin, yakPlugin], "composed twice"],
    ["a reserved flag", () => [definePlugin({ name: "a", commands: { x: verb({ output: flag.string({ summary: "o" }) }) } })], "reserved"],
    ["a non-camelCase key", () => [definePlugin({ name: "a", commands: { x: verb({ "no-way": flag.boolean({ summary: "n" }) }) } })], "camelCase"],
    ["an unsafe completion word", () => [definePlugin({ name: "a", commands: { x: verb({ f: flag.string({ summary: "f", completeValue: ["$(rm -rf ~)"] }) }) } })], "not shell-safe"],
    ["a domain helper defining the wrong function", () => [definePlugin({ name: "a", commands: { x: verb({ f: flag.string({ summary: "f", completeValue: [{ domain: "@x", helper: "other() { :; }" }] }) }) } })], "must define __fixture_dom_x()"],
    ["a rest operand before another", () => [definePlugin({ name: "a", commands: { x: defineVerb({ summary: "v", operands: { a: operand.rest({ summary: "a" }), b: operand.optional({ summary: "b" }) }, load: never }) } })], "must be last"],
    ["an extension of a missing verb", () => [definePlugin({ name: "a", commands: {}, extends: { "yak nope": defineExtension({ flags: {}, load: never }) } })], "not a plugin verb"],
    ["an extension flag colliding with the target's", () => [yakPlugin, definePlugin({ name: "b", commands: {}, extends: { "yak issue": defineExtension({ flags: { summary: flag.string({ summary: "s" }) }, load: never }) } })], "declared twice"],
    ["an empty group", () => [definePlugin({ name: "a", commands: { g: defineGroup({ summary: "g", commands: {} }) } })], "has no commands"],
  ])("%s", (_label, plugins, message) => {
    expect(() => composeProgram({ name: "fixture", plugins: plugins() })).toThrow(HeraCliManifestError);
    expect(() => composeProgram({ name: "fixture", plugins: plugins() })).toThrow(message);
  });
});
