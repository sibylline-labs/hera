import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { completionScript } from "../src/cli/manifest/index.js";
import { fixtureProgram } from "./fixtures/cli-manifest/manifest.js";

const REPO = join(import.meta.dirname, "..");
const ENTRY = join(REPO, "test/fixtures/cli-manifest/entry.ts");
const SCRATCH = join(REPO, "data/scratch/cli-completion");
/** CI gate on the child's CPU time; the local wall budget is 25 ms (both medians are printed). */
const CI_BUDGET_MS = 50;
/** A runner image without zsh skips the zsh leg; the bash leg always runs. */
const HAS_ZSH = spawnSync("zsh", ["-c", "true"]).status === 0;

mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Sources the emitted script in `shell` and completes `words` (the last is the word under the cursor). */
function complete(shell: "bash" | "zsh", words: readonly string[]): string[] {
  const file = join(SCRATCH, `fixture.${shell}`);
  writeFileSync(file, completionScript(fixtureProgram, shell));
  const call = 'COMP_WORDS=("$@"); COMP_CWORD=$(( $# - 1 )); _fixture_complete; printf "%s\\n" "${COMPREPLY[@]}"';
  const script =
    shell === "bash"
      ? `source "$0"; ${call.replace('"$@"', '"${@}"')}`
      : `autoload -U compinit && compinit -u -D; source "$0"; f() { local -a COMP_WORDS COMPREPLY; local PREFIX="\${@[-1]}"; ${call}; }; f "$@"`;
  const bin = shell === "bash" ? "/bin/bash" : "zsh";
  const res = spawnSync(bin, ["-c", script, file, ...words], { cwd: REPO, encoding: "utf8" });
  expect(res.stderr).toBe("");
  const offered = res.stdout.split("\n").filter((l) => l.length > 0);
  // zsh's bashcompinit `compgen -W` does not filter by the typed prefix; zsh's own `compadd`
  // does, against the word under the cursor, so apply that filter here.
  const typed = words[words.length - 1] ?? "";
  return shell === "zsh" ? offered.filter((w) => w.startsWith(typed)) : offered;
}

describe("completion derived from the manifest", () => {
  // admits: boundary-io: a completion emit that loads a handler module, or that drifts past the cold-start
  // budget; load order and time are runtime facts no type sees.
  test("a spawned `completion bash` loads no handler module and stays under the CI budget", () => {
    const first = spawnSync("bun", [ENTRY, "completion", "bash"], { cwd: REPO, encoding: "utf8" });
    expect(first.status).toBe(0);
    expect(first.stderr).not.toContain("HERA_FIXTURE_HANDLER_LOADED");
    expect(first.stdout).toBe(completionScript(fixtureProgram, "bash"));
    const cpu: number[] = [];
    const wall: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const res = spawnSync("bun", [ENTRY, "completion", "bash"], { cwd: REPO, encoding: "utf8", env: { ...process.env, HERA_CLI_TIMING: "1" } });
      wall.push(performance.now() - start);
      cpu.push(Number(/HERA_CLI_CPU_MS=([\d.]+)/.exec(res.stderr)?.[1] ?? Number.POSITIVE_INFINITY));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[2] ?? Number.POSITIVE_INFINITY;
    console.info(`completion bash: cpu median ${median(cpu).toFixed(1)} ms, wall median ${median(wall).toFixed(1)} ms`);
    // CPU time is the gate: wall time also counts the scheduler's wait while other test files run.
    expect(median(cpu)).toBeLessThan(CI_BUDGET_MS);
  });

  // admits: boundary-io: a non-deterministic emit (map order, a timestamp) that churns users' cached scripts.
  test("emits the same bytes every time and parses under bash 3.2", () => {
    expect(completionScript(fixtureProgram, "bash")).toBe(completionScript(fixtureProgram, "bash"));
    const file = join(SCRATCH, "syntax.bash");
    writeFileSync(file, completionScript(fixtureProgram, "bash"));
    expect(spawnSync("/bin/bash", ["-n", file]).status).toBe(0);
  });

  // admits: boundary-io: a case-table or word-walk bug that offers the wrong words at a position; only running
  // the script in the shell shows what it offers.
  test.each(HAS_ZSH ? (["bash", "zsh"] as const) : (["bash"] as const))("%s offers commands, flags (extensions included), values and operands", (shell) => {
    expect(complete(shell, ["fixture", ""])).toEqual(["completion", "docs", "yak", "skills"]);
    expect(complete(shell, ["fixture", "yak", ""])).toEqual(["issue"]);
    expect(complete(shell, ["fixture", "yak", "issue", "--p"])).toEqual(["--project"]);
    expect(complete(shell, ["fixture", "yak", "issue", "--format", ""])).toEqual(["md", "txt"]);
    expect(complete(shell, ["fixture", "yak", "issue", "--repo", ""])).toEqual(["hera", "eris"]);
    expect(complete(shell, ["fixture", "skills", "lint", "src/cli/manif"])).toEqual(["src/cli/manifest"]);
    expect(complete(shell, ["fixture", "skills", "lint", "x", ""])).toEqual([]);
  });
});
