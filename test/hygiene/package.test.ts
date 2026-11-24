/**
 * The npm tarball: what `npm publish` puts on the registry, read from real `npm pack`
 * output (offline). Because Hera exports TypeScript source files directly, the tarball
 * is judged by what a consumer resolves and what repository-only files stay out.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const NPM_TIMEOUT_MS = 25_000;

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
  readonly repository?: { readonly type?: string; readonly url?: string };
  readonly publishConfig?: { readonly access?: string };
  readonly exports: Readonly<Record<string, string | { readonly types?: string; readonly default?: string }>>;
}

function readManifest(root: string): PackageManifest {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
}

let cachedPacked: ReadonlySet<string> | undefined;

function packedFiles(): ReadonlySet<string> {
  if (cachedPacked !== undefined) return cachedPacked;
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: NPM_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run exited ${result.status ?? result.signal}\n${result.stdout}\n${result.stderr}`);
  }
  const [pack] = JSON.parse(result.stdout) as [{ readonly files: ReadonlyArray<{ readonly path: string }> }];
  if (pack === undefined) throw new Error("npm pack --dry-run returned empty JSON array");
  cachedPacked = new Set(pack.files.map((f) => f.path));
  return cachedPacked;
}

describe("npm tarball contract", () => {
  // admits: boundary-io: runs real `npm pack --dry-run --json --ignore-scripts --offline`;
  // only npm computes the final tarball file set from package.json `files`, catching missing
  // exports or leaked tests/workflows/private files that neither tsc nor ast-grep sees.
  it(
    "packs every exports target and required docs/rules/skills while excluding tests, workflows and private files",
    () => {
      const files = packedFiles();
      const manifest = readManifest(REPO_ROOT);

      const exportTargets = Object.values(manifest.exports).flatMap((entry) =>
        typeof entry === "string"
          ? [entry]
          : [entry.types, entry.default].filter((v): v is string => v !== undefined),
      );
      const normalizedTargets = [...new Set(exportTargets.map((t) => t.replace(/^\.\//, "")))];
      expect(normalizedTargets.length).toBeGreaterThan(20);
      expect(normalizedTargets.filter((t) => !files.has(t))).toEqual([]);

      for (const required of [
        "package.json",
        "LICENSE",
        "README.md",
        "CHANGELOG.md",
        "docs/ERRORS.md",
        "docs/README.md",
        "skills/hera-sdk/SKILL.md",
        "rules/ast-grep/hera-no-effect-v3.yml",
      ]) {
        expect(files.has(required), `missing from tarball: ${required}`).toBe(true);
      }

      const forbidden = [...files].filter(
        (file) =>
          /^(test|rule-tests|\.github|scripts|\.claude|thoughts|research|data)\//.test(file) ||
          /^(eris\.yaml|bun\.lock|sgconfig\.yml|tsconfig\.json|vitest\.config\.ts|CLAUDE\.md|AGENTS\.md|opencode\.json|\.gitattributes|\.gitleaks\.toml)$/.test(
            file,
          ),
      );
      expect(forbidden).toEqual([]);
    },
    30_000,
  );

  // admits: boundary-io: executes real `npm pack`, `tar -xzf`, `npm version --allow-same-version`,
  // and `npm publish --dry-run` on the unpacked package to prove the exact release commands work
  // and that `repository.url` triggers zero npm auto-correction warnings.
  it(
    "unpacks cleanly with normalized repository.url, supports --allow-same-version stamping and dry-run publishes cleanly",
    () => {
      const scratchBase = path.join(REPO_ROOT, "data", "scratch");
      fs.mkdirSync(scratchBase, { recursive: true });
      const workDir = fs.mkdtempSync(path.join(scratchBase, "pkg-pack-"));
      try {
        const pack = spawnSync(
          "npm",
          ["pack", "--ignore-scripts", "--offline", "--silent", "--pack-destination", workDir],
          { cwd: REPO_ROOT, encoding: "utf8", timeout: NPM_TIMEOUT_MS },
        );
        expect(pack.status, pack.stderr).toBe(0);
        const tgzName = pack.stdout.trim().split("\n").pop() ?? "";
        expect(tgzName).toMatch(/\.tgz$/);

        const untar = spawnSync("tar", ["-xzf", path.join(workDir, tgzName), "-C", workDir], {
          encoding: "utf8",
          timeout: NPM_TIMEOUT_MS,
        });
        expect(untar.status, untar.stderr).toBe(0);

        const unpacked = path.join(workDir, "package");
        const pkg = readManifest(unpacked);
        expect(pkg.repository).toEqual({
          type: "git",
          url: "git+https://github.com/sibylline-labs/hera.git",
        });
        expect(pkg.publishConfig).toEqual({ access: "public" });

        for (const entry of Object.values(pkg.exports)) {
          const targets =
            typeof entry === "string"
              ? [entry]
              : [entry.types, entry.default].filter((v): v is string => v !== undefined);
          for (const target of targets) {
            expect(fs.existsSync(path.join(unpacked, target)), `missing in unpacked tarball: ${target}`).toBe(true);
          }
        }
        for (const absentDir of ["test", ".github", "thoughts", ".claude", "scripts"]) {
          expect(fs.existsSync(path.join(unpacked, absentDir)), `leaked dir: ${absentDir}`).toBe(false);
        }

        // Release workflow stamps the tag version with --allow-same-version so matching the repo version succeeds.
        const sameStamp = spawnSync(
          "npm",
          ["version", pkg.version, "--no-git-tag-version", "--ignore-scripts", "--allow-same-version"],
          { cwd: unpacked, encoding: "utf8", timeout: NPM_TIMEOUT_MS },
        );
        expect(sameStamp.status, sameStamp.stderr).toBe(0);

        const nextStamp = spawnSync(
          "npm",
          ["version", "0.0.0-ci-dry-run", "--no-git-tag-version", "--ignore-scripts", "--allow-same-version"],
          { cwd: unpacked, encoding: "utf8", timeout: NPM_TIMEOUT_MS },
        );
        expect(nextStamp.status, nextStamp.stderr).toBe(0);
        expect(readManifest(unpacked).version).toBe("0.0.0-ci-dry-run");

        const dryRun = spawnSync(
          "npm",
          ["publish", "--dry-run", "--ignore-scripts", "--offline", "--tag", "ci-dry-run"],
          { cwd: unpacked, encoding: "utf8", timeout: NPM_TIMEOUT_MS },
        );
        expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
        expect(`${dryRun.stdout}\n${dryRun.stderr}`).not.toMatch(/repository\.url.*normalized/i);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
