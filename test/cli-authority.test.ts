import { Effect, Layer, Redacted, Schema } from "effect";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  ErisError,
  type HeraAuthorityCtx,
  HeraAuthorityVerifier,
  HeraCli,
  type HeraCliCtxShape,
  refuseAuthority,
} from "../src/cli/index.js";
import { HeraHttpError } from "../src/core/http/index.js";
import { ErrorSlug } from "../src/core/schema/index.js";
import { HeraTest } from "../src/testing/index.js";
import { GITHUB_TOKEN_A } from "./fixtures/provider-tokens.js";

const SECRET = "grant_01JC0000000000000000000000_s3cr3tMarkerValue";

const SkipArgs = Schema.Struct({
  gate: Schema.String,
  grant: Schema.optional(Schema.String),
});

interface Captured {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly overrides: { stdout: (s: string) => void; stderr: (s: string) => void };
}

function capture(): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    overrides: { stdout: (s) => void stdout.push(s), stderr: (s) => void stderr.push(s) },
  };
}

function skipVerb(verifier: Layer.Layer<HeraAuthorityVerifier, ErisError>, seen: Array<HeraAuthorityCtx<"gate:skip">>, reads: { n: number }) {
  return HeraCli.verb({
    name: "gate skip",
    args: SkipArgs,
    authority: {
      verb: "gate:skip",
      credential: (args) => {
        reads.n++;
        return args.grant;
      },
      params: (args) => ({ gate: args.gate }),
      verifier,
    },
    handler: (args, ctx, authority) =>
      Effect.sync(() => {
        seen.push(authority);
        ctx.stdout(`skipped ${args.gate} under ${authority.grant.id}\n`);
      }),
  });
}

describe("HeraCli.verb authority boundary", () => {
  // admits: the handler running without its grant, a re-read credential, or the credential reaching
  // output or the call log; control flow and string contents are invisible to the type checker.
  test("a grant runs the handler once with the typed ctx; the credential is read once and never printed", async () => {
    const fake = HeraTest.authority({ verbs: { "gate:skip": { grant: { id: "use-1" } } }, credential: SECRET });
    const seen: Array<HeraAuthorityCtx<"gate:skip">> = [];
    const reads = { n: 0 };
    const out = capture();

    const code = await skipVerb(fake.layer, seen, reads).run({ gate: "plan-review", grant: SECRET }, out.overrides);

    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verb).toBe("gate:skip");
    expect(seen[0]?.params).toEqual({ gate: "plan-review" });
    expect(seen[0]?.grant).toEqual({ id: "use-1" });
    expect(Redacted.value(seen[0]!.credential)).toBe(SECRET);
    expect(reads.n).toBe(1);
    expect(fake.requests).toEqual([{ verb: "gate:skip", params: { gate: "plan-review" }, command: "gate skip" }]);
    expect(JSON.stringify(fake.requests)).not.toContain(SECRET);
    expect(out.stdout.join("")).toBe("skipped plan-review under use-1\n");
    expect(out.stdout.join("") + out.stderr.join("")).not.toContain(SECRET);
  });

  // admits: a refusal that still runs the handler or loses the verifier's code; runtime control flow.
  test("a refusal exits 3 with the verifier's code and never calls the handler", async () => {
    const fake = HeraTest.authority({ verbs: { "gate:skip": { refuse: { slug: "grant-out-of-path", what: "bound to another session" } } } });
    const seen: Array<HeraAuthorityCtx<"gate:skip">> = [];
    const out = capture();

    const code = await skipVerb(fake.layer, seen, { n: 0 }).run({ gate: "plan-review", grant: SECRET }, out.overrides);

    expect(code).toBe(3);
    expect(seen).toHaveLength(0);
    expect(out.stderr.join("")).toContain("slug: grant-out-of-path");
    expect(out.stderr.join("")).toContain("bound to another session");
    expect(out.stdout.join("") + out.stderr.join("")).not.toContain(SECRET);
  });

  // admits: a fake that grants by default (a test passing on a fail-open double); runtime behaviour.
  test("a verb the fake was not told about fails closed; grant() and refuse() steer it", async () => {
    const fake = HeraTest.authority();
    const seen: Array<HeraAuthorityCtx<"gate:skip">> = [];
    const verb = skipVerb(fake.layer, seen, { n: 0 });
    const out = capture();

    expect(await verb.run({ gate: "g", grant: SECRET }, out.overrides)).toBe(3);
    expect(out.stderr.join("")).toContain("slug: authority-not-granted");

    fake.grant("gate:skip");
    expect(await verb.run({ gate: "g", grant: SECRET }, out.overrides)).toBe(0);
    expect(seen[0]?.grant.id).toBe("test-grant");

    fake.refuse("gate:skip", "grant-revoked");
    expect(await verb.run({ gate: "g", grant: SECRET }, out.overrides)).toBe(3);
    expect(out.stderr.join("")).toContain("slug: grant-revoked");
    expect(seen).toHaveLength(1);
  });

  // admits: a fake that ignores its credential pin, so a consumer test cannot exercise a bad one.
  test("a wrong credential is refused by the fake", async () => {
    const fake = HeraTest.authority({ verbs: { "gate:skip": { grant: { id: "use-1" } } }, credential: SECRET });
    const out = capture();
    const code = await skipVerb(fake.layer, [], { n: 0 }).run({ gate: "g", grant: "not-the-grant" }, out.overrides);
    expect(code).toBe(3);
    expect(out.stderr.join("")).toContain("slug: authority-credential-rejected");
  });

  // admits: a boundary that asks the verifier, or runs the handler, with no credential (fail-open).
  test.each([
    ["absent", undefined],
    ["empty", ""],
  ])("an %s credential exits 3 without calling the verifier or the handler", async (_name, grant) => {
    const fake = HeraTest.authority({ verbs: { "gate:skip": { grant: { id: "use-1" } } } });
    const seen: Array<HeraAuthorityCtx<"gate:skip">> = [];
    const out = capture();

    const code = await skipVerb(fake.layer, seen, { n: 0 }).run(
      grant === undefined ? { gate: "g" } : { gate: "g", grant },
      out.overrides,
    );

    expect(code).toBe(3);
    expect(out.stderr.join("")).toContain("slug: authority-credential-missing");
    expect(fake.requests).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  // admits: verifier-built text echoing an opaque credential that no pattern scrubber recognises;
  // string contents are invisible to the type checker.
  test.each([
    ["a refusal's what and fix", (cred: string) => Effect.fail(refuseAuthority("grant-bad", { what: `grant ${cred} is not valid`, fix: `retry without ${cred}` })), 3, "slug: grant-bad"],
    ["a refusal slug that is the credential", (cred: string) => Effect.fail(refuseAuthority(cred, { what: "refused" })), 3, "slug: authority-refused"],
    ["a transport URL", (cred: string) => Effect.fail(new HeraHttpError({ reason: "HttpStatusError", slug: ErrorSlug.make("http-status"), status: 401, url: `https://verifier.example/v1/grants/${cred}`, method: "POST" })), 1, "[REDACTED]"],
  ] as const)("the exact credential is redacted from %s", async (_name, fail, exitCode, marker) => {
    const opaque = "opaque-cred-0123456789abcdef";
    const echo = HeraAuthorityVerifier.layer({ verify: (r) => fail(Redacted.value(r.credential)) });
    const out = capture();

    const code = await skipVerb(echo, [], { n: 0 }).run({ gate: "g", grant: opaque }, out.overrides);

    expect(code).toBe(exitCode);
    expect(out.stderr.join("")).toContain(marker);
    expect(out.stdout.join("") + out.stderr.join("")).not.toContain(opaque);
  });

  // admits: a credential the pattern scrubber rewrites in part, leaving a fragment the exact-match
  // redaction no longer finds; string contents are invisible to the type checker.
  test("a scrubber-shaped credential is redacted whole, not in part", async () => {
    const shaped = `zzprefix-${GITHUB_TOKEN_A}`;
    const echo = HeraAuthorityVerifier.layer({
      verify: (r) => Effect.fail(refuseAuthority("grant-bad", { what: `bad grant ${Redacted.value(r.credential)}` })),
    });
    const out = capture();

    expect(await skipVerb(echo, [], { n: 0 }).run({ gate: "g", grant: shaped }, out.overrides)).toBe(3);
    expect(out.stderr.join("")).toContain("bad grant [REDACTED]");
    expect(out.stderr.join("")).not.toContain("zzprefix");
  });

  // admits: a verifier layer whose build error echoes the credential (read from env) escaping the
  // redaction that only wrapped verify(); runtime control flow.
  test("a verifier layer build error is redacted too", async () => {
    const opaque = "opaqueCred0123456789abcdefXYZ";
    const broken = Layer.effect(
      HeraAuthorityVerifier,
      Effect.fail(ErisError.operational("verifier-config", { what: `bad config value ${opaque}`, fix: `unset ${opaque}` })),
    );
    const verb = HeraCli.verb({
      name: "gate skip",
      authority: { verb: "gate:skip", credential: (_a, ctx) => ctx.env.PROBE_GRANT, verifier: broken },
      handler: () => Effect.void,
    });
    const out = capture();

    expect(await verb.run(undefined, { ...out.overrides, env: { PROBE_GRANT: opaque } })).toBe(1);
    expect(out.stderr.join("")).toContain("slug: verifier-config");
    expect(out.stdout.join("") + out.stderr.join("")).not.toContain(opaque);
  });

  // admits: a transport failure treated as a grant, or mapped off the timeout exit code.
  test("a verifier transport timeout exits 124 and never calls the handler", async () => {
    const timeout = HeraAuthorityVerifier.layer({
      verify: () =>
        Effect.fail(
          new HeraHttpError({
            reason: "Timeout",
            slug: ErrorSlug.make("http-timeout"),
            url: "https://verifier.example/v1/use",
            method: "POST",
            timeoutMs: 5_000,
          }),
        ),
    });
    const seen: Array<HeraAuthorityCtx<"gate:skip">> = [];
    const out = capture();

    const code = await skipVerb(timeout, seen, { n: 0 }).run({ gate: "g", grant: SECRET }, out.overrides);

    expect(code).toBe(124);
    expect(seen).toHaveLength(0);
    expect(out.stderr.join("")).not.toContain(SECRET);
  });
});

describe("HeraCli.verb authority types", () => {
  const fake = HeraTest.authority();

  // admits: an overload change that lets a plain verb's handler take an authority ctx; the
  // expect-error lines below are the type rung; this body only hosts them.
  test("a handler on a verb that declares no authority cannot reach the authority ctx", () => {
    // @ts-expect-error a verb with no `authority` hands its handler no authority ctx
    HeraCli.verb({ name: "a", handler: (_args: undefined, _ctx: HeraCliCtxShape, auth: HeraAuthorityCtx<"gate:skip">) => Effect.succeed(auth.verb) });
    // @ts-expect-error nor an unannotated third parameter
    HeraCli.verb({ name: "b", handler: (_args, _ctx, auth) => Effect.succeed(auth) });
  });

  // admits: the ctx widening to `string` or accepting another verb's type; type rung host.
  test("the ctx is parameterised by the declared verb", () => {
    HeraCli.verb({
      name: "c",
      authority: { verb: "gate:skip", credential: () => SECRET, verifier: fake.layer },
      handler: (_args, _ctx, auth) => {
        expectTypeOf(auth.verb).toEqualTypeOf<"gate:skip">();
        return Effect.void;
      },
    });
    HeraCli.verb({
      name: "d",
      authority: { verb: "gate:skip", credential: () => SECRET, verifier: fake.layer },
      // @ts-expect-error a handler typed for another verb does not fit
      handler: (_args: undefined, _ctx: HeraCliCtxShape, auth: HeraAuthorityCtx<"review:endorse">) => Effect.succeed(auth.verb),
    });
  });

  // admits: the brand being dropped so a literal forges a grant; type rung host.
  test("an object literal cannot stand in for a granted ctx", () => {
    // @ts-expect-error the ctx carries a brand only the boundary sets
    const forged: HeraAuthorityCtx<"gate:skip"> = {
      verb: "gate:skip",
      params: {},
      credential: Redacted.make(SECRET),
      grant: { id: "forged" },
    };
    expect(forged.verb).toBe("gate:skip");
  });
});
