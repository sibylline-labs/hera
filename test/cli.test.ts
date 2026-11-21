import * as fs from "node:fs";
import * as path from "node:path";
import { Duration, Effect, Fiber, Redacted, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DirLock,
  ErisError,
  HeraCli,
  HeraCliCtx,
  Runner,
  buildChildEnv,
  failureLines,
  isPidAlive,
  psSnapshot,
  renderFailureBlock,
  resolveConcurrency,
  resolveDeadlineMs,
  scrubFreeText,
  subtree,
} from "../src/cli/index.js";
import { HeraHttpError, RateLimitedError } from "../src/core/http/index.js";
import { ErrorSlug, HeraSchema } from "../src/core/schema/index.js";
import {
  ANTHROPIC_KEY,
  AWS_EXAMPLE_KEY,
  GCP_KEY_BODY,
  GITHUB_TOKEN,
  GOOGLE_API_KEY,
  JWT_IO,
  LINEAR_TOKEN,
  PEM_BEGIN_PRIVATE,
  PEM_BEGIN_RSA,
  PEM_END_PRIVATE,
  PEM_END_RSA,
  SLACK_BOT_TOKEN,
} from "./fixtures/provider-tokens.js";

const SCRATCH_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "data",
  "scratch",
  "cli-test",
);

describe("scrubFreeText & ErisError", () => {
  test("scrubFreeText redacts all 11 credential classes plus linear/hex keys and Redacted<T>", () => {
    const gcpKey = `"private_key": "${PEM_BEGIN_PRIVATE}\\n${GCP_KEY_BODY}BKcwggSjAgEAAoIBAQC7\\n${PEM_END_PRIVATE}\\n"`;
    const gcpRes = scrubFreeText(gcpKey);
    expect(gcpRes.text).toBe(`"private_key": "<redacted:gcp-private-key>"`);
    expect(gcpRes.text).not.toContain("MIIEvQIBADAN");
    expect(gcpRes.redactions).toContain("gcp-private-key");

    const pem = [
      PEM_BEGIN_RSA,
      "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB",
      PEM_END_RSA,
    ].join("\n");
    expect(scrubFreeText(pem).text).toBe("<redacted:pem>");

    const jwt = JWT_IO;
    expect(scrubFreeText(`token ${jwt}`).text).toContain("<redacted:jwt>");

    const aws = `aws_access_key_id = ${AWS_EXAMPLE_KEY}`;
    expect(scrubFreeText(aws).text).toContain("<redacted:aws-key>");

    const gh = `token: ${GITHUB_TOKEN}`;
    expect(scrubFreeText(gh).text).toContain("<redacted:github-token>");

    const slack = `slack: ${SLACK_BOT_TOKEN}`;
    expect(scrubFreeText(slack).text).toContain("<redacted:slack-token>");

    const google = `api=${GOOGLE_API_KEY}`;
    expect(scrubFreeText(google).text).toContain("<redacted:google-api-key>");

    const sk = `api: ${ANTHROPIC_KEY}`;
    expect(scrubFreeText(sk).text).toContain("<redacted:sk-key>");

    const lin = `linear: ${LINEAR_TOKEN}`;
    expect(scrubFreeText(lin).text).toContain("<redacted:sk-key>");

    const auth = "Authorization: Bearer super_secret_bearer_token_123456";
    expect(scrubFreeText(auth).text).toBe(
      "Authorization: Bearer <redacted:auth-header>",
    );

    const conn = "postgres://admin:super_secret_pw@db.example.com:5432/prod";
    expect(scrubFreeText(conn).text).toBe(
      "postgres://admin:<redacted:conn-string>@db.example.com:5432/prod",
    );
    expect(scrubFreeText(conn).text).not.toContain("super_secret_pw");

    const assign = "TURSO_AUTH_TOKEN=eySecretTokenValue123456789";
    expect(scrubFreeText(assign).text).toBe(
      "TURSO_AUTH_TOKEN=<redacted:assignment>",
    );
    expect(scrubFreeText(assign).text).not.toContain("eySecretTokenValue");

    const hexKey =
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(scrubFreeText(hexKey).text).toBe("<redacted:assignment>");

    const redactedVal = Redacted.make("my-top-secret-value");
    expect(scrubFreeText(redactedVal).text).toBe("<redacted>");
  });

  // admits: a failure block that leaks a credential or drops the `fix: ` prefix on a continuation line; output text has no type.
  test("ErisError constructors map exit codes and render 4-line failure block with scrubbing", () => {
    const op = ErisError.operational("vault-pull-failed", {
      what: `Failed with key ${ANTHROPIC_KEY}`,
      fix: `Run \`eris auth login\` with token=${GITHUB_TOKEN}\nThen retry \`eris pull\``,
      docs: "docs/ERRORS.md#vault-pull-failed",
    });
    expect(op.exitCode).toBe(1);
    expect(op.what).toContain("<redacted:sk-key>");
    expect(op.what).not.toContain("sk-ant-api03");
    expect(op.fix).toContain("<redacted:github-token>");

    const lines = failureLines(op, {
      erisHome: "/Users/test/.eris",
      docsBase: "https://github.com/sibylline-labs/eris/blob/main",
    });
    expect(lines[0]).toBe("ERROR Failed with key <redacted:sk-key>");
    expect(lines[1]).toBe("slug: vault-pull-failed");
    expect(lines[2]).toBe(
      "fix: Run `eris auth login` with token=<redacted:github-token>",
    );
    expect(lines[3]).toBe("fix: Then retry `eris pull`");
    expect(lines[4]).toBe(
      "docs: /Users/test/.eris/docs/ERRORS.md#vault-pull-failed",
    );
    expect(lines[5]).toBe(
      "docs: https://github.com/sibylline-labs/eris/blob/main/docs/ERRORS.md#vault-pull-failed",
    );
    expect(
      renderFailureBlock(op, {
        erisHome: "/Users/test/.eris",
        docsBase: "https://github.com/sibylline-labs/eris/blob/main",
      }),
    ).toBe(`${lines.join("\n")}\n`);

    expect(
      ErisError.usage("invalid-args", {
        what: "Bad flag",
        fix: "Pass --env",
      }).exitCode,
    ).toBe(2);

    expect(
      ErisError.precondition("missing-lock", {
        what: "No lock",
        fix: "Wait",
      }).exitCode,
    ).toBe(3);

    expect(
      ErisError.timeout("cmd-timed-out", {
        what: "Exceeded 5000ms",
        fix: "Increase timeout",
      }).exitCode,
    ).toBe(124);
  });

  test("ErisError.fromHttpError maps timeout to 124 and rate-limit to operational 1", () => {
    const timeoutHttp = new HeraHttpError({
      reason: "Timeout",
      slug: ErrorSlug.make("http-timeout"),
      method: "GET",
      url: "https://polaris.example.com/v1/keys",
      timeoutMs: 3000,
    });
    const mappedTimeout = ErisError.fromHttpError(timeoutHttp);
    expect(mappedTimeout.exitCode).toBe(124);
    expect(mappedTimeout.slug).toBe("http-timeout");

    const rl = new RateLimitedError({
      slug: ErrorSlug.make("http-rate-limited"),
      status: 429,
      retryAfterSeconds: 12,
      retryAfterMs: 12_000,
      url: "https://polaris.example.com/v1/keys",
      method: "POST",
    });
    const mappedRl = ErisError.fromHttpError(rl);
    expect(mappedRl.exitCode).toBe(1);
    expect(mappedRl.slug).toBe("http-rate-limited");
    expect(mappedRl.fix).toContain("12s");
  });
});

describe("Runner subprocess management & tree kill", () => {
  test("buildChildEnv strips BUN_CONFIG_VERBOSE_FETCH and sets _ERIS_SHIM_IGNORED=1", () => {
    const prevVerbose = process.env.BUN_CONFIG_VERBOSE_FETCH;
    process.env.BUN_CONFIG_VERBOSE_FETCH = "1";
    try {
      const env = buildChildEnv({
        BUN_CONFIG_VERBOSE_FETCH: "true",
        CUSTOM_VAR: "ok",
      });
      expect(env.BUN_CONFIG_VERBOSE_FETCH).toBeUndefined();
      expect(env._ERIS_SHIM_IGNORED).toBe("1");
      expect(env.CUSTOM_VAR).toBe("ok");
    } finally {
      if (prevVerbose === undefined) {
        delete process.env.BUN_CONFIG_VERBOSE_FETCH;
      } else {
        process.env.BUN_CONFIG_VERBOSE_FETCH = prevVerbose;
      }
    }
  });

  test("Runner executes command, captures stdout/stderr, and strips BUN_CONFIG_VERBOSE_FETCH in child", async () => {
    const prevVerbose = process.env.BUN_CONFIG_VERBOSE_FETCH;
    process.env.BUN_CONFIG_VERBOSE_FETCH = "1";
    try {
      const program = Runner.run({
        cmd: "bun",
        args: [
          "-e",
          'process.stdout.write(`verbose=${process.env.BUN_CONFIG_VERBOSE_FETCH ?? "unset"},shim=${process.env._ERIS_SHIM_IGNORED}`)',
        ],
        timeoutMs: 5_000,
      }).pipe(Effect.provide(Runner.live));

      const res = await Effect.runPromise(program);
      expect(res.exitCode).toBe(0);
      expect(res.timedOut).toBe(false);
      expect(res.stdout).toBe("verbose=unset,shim=1");
    } finally {
      if (prevVerbose === undefined) {
        delete process.env.BUN_CONFIG_VERBOSE_FETCH;
      } else {
        process.env.BUN_CONFIG_VERBOSE_FETCH = prevVerbose;
      }
    }
  });

  test("Runner kills entire process subtree (parent + grandchild) on timeout and returns exitCode 124", async () => {
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    const pidFile = path.join(SCRATCH_ROOT, `timeout-pids-${Date.now()}.txt`);

    // Parent spawns a grandchild that ignores SIGTERM and holds stdout open
    const childCode = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const grand = spawn("bun", ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, grand: grand.pid }));
      setInterval(() => {}, 1000);
    `;

    try {
      const program = Runner.run({
        cmd: "bun",
        args: ["-e", childCode],
        timeoutMs: 250,
        killGraceMs: 150,
      }).pipe(Effect.provide(Runner.live));

      const res = await Effect.runPromise(program);
      expect(res.exitCode).toBe(124);
      expect(res.timedOut).toBe(true);
      expect(res.escalated).toBe(true);

      const recorded = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
        parent: number;
        grand: number;
      };
      expect(recorded.parent).toBeGreaterThan(0);
      expect(recorded.grand).toBeGreaterThan(0);
      expect(isPidAlive(recorded.parent)).toBe(false);
      expect(isPidAlive(recorded.grand)).toBe(false);
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  test("Runner kills entire process subtree on Fiber.interrupt", async () => {
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    const pidFile = path.join(SCRATCH_ROOT, `interrupt-pids-${Date.now()}.txt`);

    const childCode = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const grand = spawn("bun", ["-e", "setInterval(() => {}, 1000);"], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, grand: grand.pid }));
      setInterval(() => {}, 1000);
    `;

    try {
      const program = Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Runner.run({
            cmd: "bun",
            args: ["-e", childCode],
            timeoutMs: 30_000,
            killGraceMs: 150,
          }),
        );

        for (let i = 0; i < 60; i++) {
          if (fs.existsSync(pidFile)) break;
          yield* Effect.sleep(Duration.millis(25));
        }
        expect(fs.existsSync(pidFile)).toBe(true);

        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(Runner.live));

      await Effect.runPromise(program);

      // Give brief window for OS process table cleanup after finalizer
      await new Promise((r) => setTimeout(r, 100));

      const recorded = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
        parent: number;
        grand: number;
      };
      expect(isPidAlive(recorded.parent)).toBe(false);
      expect(isPidAlive(recorded.grand)).toBe(false);
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  test("psSnapshot and subtree compute descendants in bottom-up order", () => {
    const byParent = new Map<number, number[]>([
      [1, [100, 999]],
      [100, [200]],
      [200, [300]],
    ]);
    const order = subtree(100, byParent);
    expect(order).toEqual([300, 200, 100]);

    const liveSnap = psSnapshot();
    expect(liveSnap.size).toBeGreaterThan(0);
  });
});

describe("DirLock", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(
      SCRATCH_ROOT,
      `pair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("DirLock acquires, rejects contention, breaks dead-PID locks, and releases in finalizer", async () => {
    const lockDir = path.join(testDir, ".eris-lock");

    // Contention with live PID
    const lease = DirLock.acquireSync(testDir);
    expect(() => DirLock.acquireSync(testDir)).toThrow();
    lease.release();
    expect(fs.existsSync(lockDir)).toBe(false);

    // Stale lock with dead PID (PID 999999)
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "pid"), "999999\n");
    const recoveredLease = DirLock.acquireSync(testDir);
    recoveredLease.release();
    expect(fs.existsSync(lockDir)).toBe(false);

    // Scoped withLock releases on error
    const exit = await Effect.runPromiseExit(
      DirLock.withLock(
        testDir,
        Effect.fail(
          ErisError.operational("inner-fail", {
            what: "inner failed",
            fix: "none",
          }),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});

describe("HeraCli.verb & HeraCli.forEachBounded", () => {
  test("HeraCli.verb validates args via HeraSchema, injects HeraCliCtx, and maps exit codes", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const PullArgs = Schema.Struct({
      env: Schema.Literals(["dev", "prod"]),
      token: Schema.optional(Schema.String),
    });

    const pullVerb = HeraCli.verb({
      name: "pull",
      args: PullArgs,
      handler: (args) =>
        Effect.gen(function* () {
          const ctx = yield* HeraCliCtx.current;
          ctx.stdout(`pulled env=${args.env} home=${ctx.erisHome}\n`);
        }),
    });

    const okCode = await pullVerb.run(
      { env: "dev" },
      {
        erisHome: "/Users/test/.eris-custom",
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
      },
    );
    expect(okCode).toBe(0);
    expect(stdout.join("")).toBe("pulled env=dev home=/Users/test/.eris-custom\n");
    expect(stderr).toHaveLength(0);

    // Invalid args with secret value must return exitCode 2 and never echo the secret to stderr
    const badCode = await pullVerb.run(
      {
        env: "staging",
        token: ANTHROPIC_KEY,
      },
      {
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
      },
    );
    expect(badCode).toBe(2);
    const errText = stderr.join("");
    expect(errText).toContain("slug: pull-invalid-args");
    expect(errText).not.toContain("sk-ant-api03");
  });

  test("HeraCli.verb catches unexpected defects (Effect.die) into closed cli-internal-error block", async () => {
    const stderr: string[] = [];
    const crashVerb = HeraCli.verb({
      name: "crash",
      args: Schema.Struct({}),
      handler: () =>
        Effect.die(
          new Error(
            `Leak attempt: ${GITHUB_TOKEN}`,
          ),
        ),
    });

    const code = await crashVerb.run(
      {},
      {
        stderr: (s) => stderr.push(s),
      },
    );
    expect(code).toBe(1);
    const errText = stderr.join("");
    expect(errText).toContain("slug: cli-internal-error");
    expect(errText).not.toContain("ghp_1234567890");
  });

  // admits: a pool that exceeds its concurrency, ignores its deadline, or reads a seconds env var as ms; runtime scheduling has no type.
  test("HeraCli.forEachBounded respects concurrency, deadline, failFast, and validate modes", async () => {
    expect(
      resolveConcurrency(
        { envVar: "ERIS_CONCURRENCY", maxConcurrency: 32 },
        { ERIS_CONCURRENCY: "12" },
      ),
    ).toBe(12);
    expect(
      resolveConcurrency(
        { envVar: "ERIS_CONCURRENCY", maxConcurrency: 32 },
        { ERIS_CONCURRENCY: "999" },
      ),
    ).toBe(32);
    expect(
      resolveDeadlineMs(
        { deadlineEnvVar: "ERIS_BATCH_TIMEOUT" },
        { ERIS_BATCH_TIMEOUT: "45" },
      ),
    ).toBe(45_000);

    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6];

    const results = await Effect.runPromise(
      HeraCli.forEachBounded(
        items,
        (n) =>
          Effect.gen(function* () {
            active++;
            if (active > maxActive) maxActive = active;
            yield* Effect.sleep(Duration.millis(20));
            active--;
            return n * 2;
          }),
        { concurrency: 2, deadlineMs: 5_000 },
      ),
    );
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBeLessThanOrEqual(2);

    // Validate mode accumulates successes and failures without short-circuiting
    const validateReport = await Effect.runPromise(
      HeraCli.forEachBounded(
        [1, 2, 3],
        (n) =>
          n === 2
            ? Effect.succeed(n * 10)
            : Effect.fail(
                ErisError.operational(`fail-${n}`, {
                  what: `Item ${n} failed`,
                  fix: "Retry",
                }),
              ),
        { concurrency: 2, mode: "validate" },
      ),
    );
    expect(validateReport.successes).toEqual([20]);
    expect(validateReport.failures).toHaveLength(2);
    expect(validateReport.failures[0]?.error.slug).toBe("fail-1");
    expect(validateReport.failures[1]?.error.slug).toBe("fail-3");
  });
});
