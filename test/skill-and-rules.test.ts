import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

describe("Dune ast-grep ruleset & hera-sdk skill", () => {
  // admits: boundary-io: a rule file or its rule-tests missing from rules/ast-grep, which the scan would skip silently.
  it("declares sgconfig.yml and all 7 canonical ast-grep rules + rule-tests", () => {
    const sgConfigPath = resolve(repoRoot, "sgconfig.yml");
    expect(existsSync(sgConfigPath)).toBe(true);
    const sgConfig = readFileSync(sgConfigPath, "utf8");
    expect(sgConfig).toContain("rules/ast-grep");
    expect(sgConfig).toContain("rule-tests");

    const expectedRules = [
      "hera-no-raw-effect-run",
      "hera-no-effect-v3",
      "hera-single-fn-syntax",
      "hera-no-hand-rolled-ctx",
      "hera-tui-vendorable",
      "hera-tui-lazy",
      "hera-alarm-via-driver",
      "hera-no-global-otel",
      "hera-agent-tool-via-hera",
      "hera-no-isolate-state",
      "hera-cli-manifest-pure",
      "hera-no-global-fetch-mutation",
    ] as const;

    for (const ruleId of expectedRules) {
      const rulePath = resolve(repoRoot, "rules/ast-grep", `${ruleId}.yml`);
      const testPath = resolve(repoRoot, "rule-tests", `${ruleId}-test.yml`);
      expect(existsSync(rulePath)).toBe(true);
      expect(existsSync(testPath)).toBe(true);

      const ruleContent = readFileSync(rulePath, "utf8");
      const testContent = readFileSync(testPath, "utf8");
      expect(ruleContent).toContain(`id: ${ruleId}`);
      expect(testContent).toContain(`id: ${ruleId}`);
      expect(testContent).toContain("valid:");
      expect(testContent).toContain("invalid:");
    }
  });

  // admits: boundary-io: a rule whose valid/invalid cases stop matching, or a src/ hit, run through the real ast-grep binary.
  it("passes ast-grep scan and ast-grep test --skip-snapshot-tests cleanly", () => {
    const scanOut = execFileSync("ast-grep", ["scan"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(scanOut.trim()).toBe("");

    const testOut = execFileSync("ast-grep", ["test", "--skip-snapshot-tests"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(testOut).toContain("12 passed; 0 failed");
  });

  it("ships skills/hera-sdk/SKILL.md with YAML frontmatter, # WRONG / # RIGHT pairs for all 6 surfaces, and migration guide", () => {
    const skillPath = resolve(repoRoot, "skills/hera-sdk/SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const content = readFileSync(skillPath, "utf8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: hera-sdk");
    expect(content).toContain("description:");

    // All 6 surfaces documented
    expect(content).toContain("Surface 1: `HeraSchema` & `HeraConfig`");
    expect(content).toContain("Surface 2: `HeraCtx` & `HeraLogger`");
    expect(content).toContain("Surface 3: `Hera.fn`, `HeraError`, Routes & Cloudflare RPC");
    expect(content).toContain("Surface 4: `TenantDurableObject`, `SyncTx` & Transactional Outbox");
    expect(content).toContain("Surface 5: `HeraCli` & `HeraHttp`");
    expect(content).toContain("Surface 6: `HeraTest` (`@sibylline-labs/hera/testing`)");

    // 6 canonical # WRONG / # RIGHT pairs (one per surface)
    const wrongMatches = content.match(/# WRONG/g) ?? [];
    const rightMatches = content.match(/# RIGHT/g) ?? [];
    expect(wrongMatches.length).toBeGreaterThanOrEqual(6);
    expect(rightMatches.length).toBeGreaterThanOrEqual(6);

    // Explains the raw-combinator and Effect v3 bans and the migration guide
    expect(content).toContain("## Why Raw `Effect` Combinators and Effect v3 APIs Are Banned");
    expect(content).toContain("hera-no-raw-effect-run");
    expect(content).toContain("hera-no-effect-v3");
    expect(content).toContain("hera-single-fn-syntax");
    expect(content).toContain("hera-no-hand-rolled-ctx");
    expect(content).toContain("hera-alarm-via-driver");
    expect(content).toContain("hera-no-isolate-state");
    expect(content).toContain("Migration Guide");
  });
});
