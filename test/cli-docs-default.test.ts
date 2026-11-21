import { Effect, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { ErisError, HeraCli, failureLines } from "../src/cli/index.js";
import { HeraTest } from "../src/testing/index.js";

const BASE = "https://example.test/blob/main";

function capture(): { lines: string[]; put: (s: string) => void } {
  const lines: string[] = [];
  return { lines, put: (s) => void lines.push(s) };
}

describe("failure block docs default", () => {
  // admits: a lowercase docs/errors.md default 404s on case-sensitive hosts; runtime
  test("an error with no docs links docs/ERRORS.md, the file name eris publishes", () => {
    const lines = failureLines(ErisError.usage("x-usage", { what: "bad" }), {
      erisHome: "/h/.eris",
      docsBase: BASE,
    });
    expect(lines).toContain("docs: /h/.eris/docs/ERRORS.md#x-usage");
    expect(lines).toContain(`docs: ${BASE}/docs/ERRORS.md#x-usage`);
  });

  // admits: the verb builds this error itself, so a consumer cannot pass docs per error; runtime
  test("a verb's own usage error uses the verb's docs path and base", async () => {
    const err = capture();
    const verb = HeraCli.verb({
      name: "thing",
      args: Schema.Struct({ n: Schema.Number }),
      docs: { base: BASE, path: "docs/CLI.md" },
      handler: () => Effect.void,
    });
    expect(await verb.run({ n: "x" }, { erisHome: "/h/.eris", stderr: err.put })).toBe(2);
    const text = err.lines.join("");
    expect(text).toContain(`docs: ${BASE}/docs/CLI.md#thing-invalid-args`);
    expect(text).toContain("docs: /h/.eris/docs/CLI.md#thing-invalid-args");
  });

  // admits: the internal-error block ignored the verb's docs default; runtime
  test("cli-internal-error follows the verb's docs config", async () => {
    const err = capture();
    const verb = HeraCli.verb({
      name: "crash",
      docs: { base: BASE },
      handler: () => Effect.die(new Error("boom")),
    });
    expect(await verb.run(undefined, { stderr: err.put })).toBe(1);
    expect(err.lines.join("")).toContain(`docs: ${BASE}/docs/ERRORS.md#cli-internal-error`);
  });

  // admits: the config default silently overriding an explicit per-run docsBase; runtime
  test("a per-run ctx override beats the verb's docs config", async () => {
    const err = capture();
    const verb = HeraCli.verb({
      name: "crash",
      docs: { base: BASE },
      handler: () => Effect.die(new Error("boom")),
    });
    await verb.run(undefined, { stderr: err.put, docsBase: "https://other.test/x" });
    const text = err.lines.join("");
    expect(text).toContain("docs: https://other.test/x/docs/ERRORS.md#cli-internal-error");
    expect(text).not.toContain(BASE);
  });

  // admits: a blank docs value producing a bare `#<slug>` link or a `/docs/...` URL; runtime string handling.
  test("a blank docs path or base falls back to the defaults", () => {
    const lines = failureLines(ErisError.usage("x-usage", { what: "bad" }), {
      erisHome: "/h/.eris",
      docsBase: "  ",
      docsPath: "",
    });
    expect(lines[lines.length - 2]).toBe("docs: /h/.eris/docs/ERRORS.md#x-usage");
    expect(lines[lines.length - 1]).toMatch(/^docs: https:\/\/\S+\/docs\/ERRORS\.md#x-usage$/);
  });

  // admits: an authority refusal (built by the verb, no docs) ignoring the verb's docs config; runtime render.
  test("an authority refusal renders the verb's docs default", async () => {
    const err = capture();
    const fake = HeraTest.authority({ verbs: { "gate:skip": { refuse: { slug: "grant-out-of-path", what: "bound elsewhere" } } } });
    const verb = HeraCli.verb({
      name: "gate skip",
      docs: { base: BASE, path: "docs/CLI.md" },
      authority: { verb: "gate:skip", credential: () => "grant-value", verifier: fake.layer },
      handler: () => Effect.void,
    });
    expect(await verb.run(undefined, { erisHome: "/h/.eris", stderr: err.put })).toBe(3);
    expect(err.lines.join("")).toContain(`docs: ${BASE}/docs/CLI.md#grant-out-of-path`);
  });
});
