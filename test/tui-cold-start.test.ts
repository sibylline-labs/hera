import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/** An eris invocation stays under 50ms, so the TUI must cost nothing until `record` asks. */
const ERIS_D1_BUDGET_MS = 50;

describe("hera/tui is lazy and fits the eris cold-start budget", () => {
  test("importing hera/cli loads no TUI module; importing hera/tui afterwards is under 50ms", () => {
    const repoRoot = join(import.meta.dirname, "..");
    const scratchDir = join(repoRoot, "data", "scratch");
    mkdirSync(scratchDir, { recursive: true });
    const probePath = join(scratchDir, "tui-cold-start-probe.ts");

    // Bun's `require.cache` lists every module loaded so far, ESM included.
    writeFileSync(
      probePath,
      [
        `const isTui = (id: string) => id.includes("/src/cli/tui/");`,
        `await import("../../src/cli/index.ts");`,
        `const afterCli = Object.keys(require.cache).filter(isTui);`,
        `const start = performance.now();`,
        `const tui = await import("../../src/cli/tui/index.ts");`,
        `const tuiMs = performance.now() - start;`,
        `const afterTui = Object.keys(require.cache).filter(isTui);`,
        `console.log(JSON.stringify({ afterCli, afterTui: afterTui.length, tuiMs, run: typeof tui.HeraTui.run }));`,
      ].join("\n"),
      "utf8",
    );

    try {
      const result = spawnSync("bun", [probePath], { cwd: repoRoot, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const probe = JSON.parse(result.stdout.trim()) as {
        afterCli: Array<string>;
        afterTui: number;
        tuiMs: number;
        run: string;
      };

      expect(probe.afterCli).toEqual([]);
      expect(probe.afterTui).toBe(5);
      expect(probe.run).toBe("function");
      expect(probe.tuiMs).toBeLessThan(ERIS_D1_BUDGET_MS);
    } finally {
      rmSync(probePath, { force: true });
    }
  });
});
