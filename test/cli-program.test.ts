import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { HeraCli, type HeraCliCtxInput, fn } from "../src/cli/index.js";
import { HeraTest } from "../src/testing/index.js";
import { fixtureProgram } from "./fixtures/cli-manifest/manifest.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: HeraCliCtxInput = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), erisHome: "/eris-home", env: {} };
  return { out, err, ctx, stdout: () => out.join(""), stderr: () => err.join("") };
}

const cli = HeraCli.program(fixtureProgram);

describe("HeraCli.program: one declaration, run end to end", () => {
  // admits: integration: an extension value failing to reach the base handler's payload through the hook point
  // (the shape that replaces a `globalThis.fetch` patch), or extension flags leaking into the base args.
  test("an extension's flag reaches the payload through the hook; the base handler never sees it", async () => {
    const s = io();
    const code = await cli.run(["--json", "yak", "issue", "--summary", "hi", "--repo", "a", "--repo", "b", "--project", " P1 ", "-n"], s.ctx);
    expect(s.stderr()).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(s.stdout())).toEqual({
      payload: { summary: "hi", repos: ["a", "b"], project: "P1" },
      format: null,
      count: null,
      noRedact: true,
      json: true,
    });
  });

  // admits: integration: the hook altering a payload when its extension flag is absent.
  test("with no extension flag the payload passes through unchanged", async () => {
    const s = io();
    expect(await cli.run(["yak", "issue", "--summary", "hi", "--count", "3", "--format", "md"], s.ctx)).toBe(0);
    expect(JSON.parse(s.stdout())).toMatchObject({ payload: { summary: "hi", repos: [] }, format: "md", count: 3, json: false });
  });

  // admits: integration: a refusal on any leg (tokenizer, derived schema, extension hook, json allow-list,
  // routing) rendering without its slug or with the wrong exit code.
  test.each([
    [["yak", "issue", "--summary", "x", "--bogus"], 2, "slug: yak-unknown-flag"],
    [["yak", "issue"], 2, "slug: yak-missing-flag"],
    [["yak", "issue", "--summary", "x", "--count", "1.5"], 2, "slug: yak-invalid-args"],
    [["yak", "issue", "--summary", "x", "--format", "html"], 2, "slug: yak-invalid-args"],
    [["yak", "issue", "--summary", "x", "--project", "p".repeat(201)], 2, "slug: yak-invalid-args"],
    [["yak", "issue", "--summary", "x", "--project", "  "], 2, "slug: yak-project-empty"],
    [["skills", "lint", "--json"], 2, "slug: output-json-unsupported"],
    [["skills", "lint", "--strict", "bad"], 1, "slug: skills-lint-failed"],
    [["nope"], 2, "slug: fixture-unknown-command"],
  ])("%j exits %i with %s", async (argv, exit, slug) => {
    const s = io();
    expect(await cli.run(argv, s.ctx)).toBe(exit);
    expect(s.stderr()).toContain(slug);
    expect(s.stdout()).toBe("");
  });

  // admits: integration: help or docs dispatching into a handler instead of answering from the manifest.
  test("help, help-json, version and docs answer without dispatch", async () => {
    const s = io();
    expect(await cli.run(["yak", "issue", "--help", "--output", "json"], s.ctx)).toBe(0);
    expect(JSON.parse(s.stdout()).schema).toBe("eris-help/1");
    const v = io();
    expect(await cli.run(["--version"], v.ctx)).toBe(0);
    expect(v.stdout()).toBe("fixture 1.2.3\n");
    const d = io();
    expect(await cli.run(["docs", "--json"], d.ctx)).toBe(0);
    expect((JSON.parse(d.stdout()) as unknown[]).length).toBe(fixtureProgram.nodes.size);
  });

  // admits: integration: a lazy verb skipping its authority check, or running its handler on a refusal.
  test("a lazy verb's authority runs before its handler", async () => {
    const args = HeraCli.args({ flags: { grant: HeraCli.flag.string({ summary: "The grant" }) } });
    const ran: string[] = [];
    const prog = HeraCli.compose({
      name: "tool",
      plugins: [
        HeraCli.plugin({
          name: "gate",
          commands: {
            skip: HeraCli.verb({
              summary: "Skip a gate",
              ...args,
              load: async () =>
                HeraCli.handler(args, {
                  authority: {
                    verb: "gate:skip",
                    credential: (a) => a.grant,
                    verifier: HeraTest.authority({ verbs: { "gate:skip": { grant: { id: "g-1" } } }, credential: "tok" }).layer,
                  },
                  run: (_a, _ctx, granted) =>
                    fn("Gate.skip")(function* () {
                      ran.push(granted.grant.id);
                      yield* Effect.void;
                    })(),
                }),
            }),
          },
        }),
      ],
    });
    const ok = io();
    expect(await HeraCli.program(prog).run(["skip", "--grant", "tok"], ok.ctx)).toBe(0);
    const refused = io();
    expect(await HeraCli.program(prog).run(["skip"], refused.ctx)).toBe(3);
    expect(refused.stderr()).toContain("slug: authority-credential-missing");
    expect(ran).toEqual(["g-1"]);
  });

  // admits: integration: a load thunk resolving to something other than a handler crashing the binary instead
  // of exiting 1 with a slug.
  test("a malformed load exits 1 with cli-handler-load-failed", async () => {
    const prog = HeraCli.compose({
      name: "tool",
      plugins: [
        HeraCli.plugin({
          name: "p",
          commands: { x: HeraCli.verb({ summary: "x", load: async () => ({ _tag: "HeraCliHandler" }) as never }) },
        }),
      ],
    });
    const s = io();
    expect(await HeraCli.program(prog).run(["x"], s.ctx)).toBe(1);
    expect(s.stderr()).toContain("slug: cli-handler-load-failed");
  });
});
