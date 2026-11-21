import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GITHUB_TOKEN } from "./fixtures/provider-tokens.js";

describe("Cold-start import, decode budget (< 5ms), and bun build --compile compatibility", () => {
  // admits: a schema import or warm decode on the CLI cold path growing past 5 ms; time is invisible
  // to types.
  test("imports @sibylline-labs/hera/schema and validates representative payloads within budget", async () => {
    const schemaMod = await import("../src/core/schema/index.js");
    const decodeSrn = schemaMod.decodeUnknownSync(schemaMod.Srn);
    const decodeOrg = schemaMod.decodeUnknownSync(schemaMod.OrgId);
    const rawSrn = "srn:sibylline:zenith-api:prod:secret:DATABASE_URL";
    const rawOrg = "org_01HZY3N8Q2W5K7M9P1R3T5V7X9";

    // Warm up JIT once, and check the values outside the timed block.
    const parsed = schemaMod.parseSrn(decodeSrn(rawSrn));
    expect(parsed.service).toBe(schemaMod.ServiceName.make("zenith-api"));
    expect(decodeOrg(rawOrg)).toBe(rawOrg);

    const start = performance.now();
    schemaMod.parseSrn(decodeSrn(rawSrn));
    decodeOrg(rawOrg);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(5);
  });

  test("compiles a standalone CLI smoke binary via bun build --compile with zero cloudflare:workers dependency", () => {
    const repoRoot = join(import.meta.dirname, "..");
    const scratchDir = join(repoRoot, "data", "scratch");
    mkdirSync(scratchDir, { recursive: true });

    const entryPath = join(scratchDir, "hera-cli-compile-smoke.ts");
    const outBinary = join(scratchDir, "hera-cli-compile-smoke-bin");

    try {
      writeFileSync(
        entryPath,
        [
          `import { HeraSchema, parseSrn, Srn, decodeUnknownSync } from "../../src/core/schema/index.ts";`,
          `import { ErisError, HeraCli, scrubFreeText } from "../../src/cli/index.ts";`,
          `import { parseRetryAfter, HeraHttp } from "../../src/core/http/index.ts";`,
          `const srn = Srn.make("srn:sibylline:zenith-api:prod:secret:DATABASE_URL");`,
          `const parsed = parseSrn(srn);`,
          `const err = ErisError.usage("bad-arg", { what: "token=${GITHUB_TOKEN}", fix: "check flags" });`,
          `const retry = parseRetryAfter("30");`,
          `if (parsed.service !== "zenith-api" || !HeraSchema.Srn.is(srn) || err.exitCode !== 2 || !scrubFreeText(err.what).text.includes("<redacted:github-token>") || retry.retryAfterSeconds !== 30 || typeof HeraCli.verb !== "function" || typeof HeraHttp.get !== "function") {`,
          `  process.exit(1);`,
          `}`,
          `console.log("HERA_COMPILE_SMOKE_OK");`,
        ].join("\n"),
        "utf8",
      );

      const compileResult = spawnSync(
        "bun",
        ["build", "--compile", entryPath, "--outfile", outBinary],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );
      expect(compileResult.status).toBe(0);
      expect(existsSync(outBinary)).toBe(true);

      const runResult = spawnSync(outBinary, [], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(runResult.status).toBe(0);
      expect(runResult.stdout.trim()).toBe("HERA_COMPILE_SMOKE_OK");
    } finally {
      rmSync(entryPath, { force: true });
      rmSync(outBinary, { force: true });
    }
  });
});
