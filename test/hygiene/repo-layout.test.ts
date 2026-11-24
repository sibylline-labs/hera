import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const MAX_LINES_PER_SRC_FILE = 300;
const ALLOWED_PLANES = new Set(["core", "server", "cli", "testing"]);

function walkFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function extractRelativeAndBuiltinImports(source: string): string[] {
  const specs: string[] = [];
  const importExportRe =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImportRe = /import\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(importExportRe)) {
    if (match[1]) specs.push(match[1]);
  }
  for (const match of source.matchAll(dynamicImportRe)) {
    if (match[1]) specs.push(match[1]);
  }
  return specs;
}

function resolvePlaneForSrcFile(absPath: string): string {
  const rel = path.relative(SRC_ROOT, absPath).split(path.sep);
  if (rel.length === 1 && rel[0] === "index.ts") {
    return "root";
  }
  return rel[0] ?? "unknown";
}

describe("SDK repository layout & documentation hygiene", () => {
  // admits: a new top-level directory in src/ (a product-contract plane among them), which no
  // import or type sees.
  it("keeps only index.ts at the top level of src/ and scopes all code under the 4 planes", () => {
    const entries = fs.readdirSync(SRC_ROOT, { withFileTypes: true });
    const rootFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
    const rootDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    expect(rootFiles).toEqual(["index.ts"]);
    for (const dir of rootDirs) {
      expect(ALLOWED_PLANES.has(dir)).toBe(true);
    }
  });

  it(`enforces <= ${MAX_LINES_PER_SRC_FILE} lines for every .ts file under src/`, () => {
    const srcFiles = walkFiles(SRC_ROOT, ".ts");
    expect(srcFiles.length).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, "utf8");
      const lineCount = content.split("\n").length;
      if (lineCount > MAX_LINES_PER_SRC_FILE) {
        const rel = path.relative(REPO_ROOT, file);
        violations.push(`${rel} (${lineCount} lines > ${MAX_LINES_PER_SRC_FILE})`);
      }
    }

    expect(violations).toEqual([]);
  });

  // admits: a relative import that crosses planes, so Node builtins reach Worker bundles or the CLI
  // pulls in the server plane.
  it("enforces strict import isolation between core, server, cli, and testing planes", () => {
    const srcFiles = walkFiles(SRC_ROOT, ".ts");
    const violations: string[] = [];
    const nodeOnlyBuiltins = new Set([
      "node:child_process",
      "child_process",
      "node:fs",
      "fs",
      "node:fs/promises",
      "fs/promises",
      "node:os",
      "os",
    ]);

    for (const file of srcFiles) {
      const fromPlane = resolvePlaneForSrcFile(file);
      const content = fs.readFileSync(file, "utf8");
      const specs = extractRelativeAndBuiltinImports(content);
      const relFile = path.relative(REPO_ROOT, file);

      for (const spec of specs) {
        if (
          (fromPlane === "core" || fromPlane === "server" || fromPlane === "root") &&
          nodeOnlyBuiltins.has(spec)
        ) {
          violations.push(`${relFile} (${fromPlane}) imports Node-only builtin "${spec}"`);
        }

        if (spec.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), spec);
          const targetPlane = resolvePlaneForSrcFile(resolved);

          if (fromPlane === "core" && targetPlane !== "core") {
            violations.push(`${relFile} (core) must not import from ${targetPlane} ("${spec}")`);
          }
          if (fromPlane === "server" && !["server", "core"].includes(targetPlane)) {
            violations.push(`${relFile} (server) must not import from ${targetPlane} ("${spec}")`);
          }
          if (fromPlane === "cli" && !["cli", "core"].includes(targetPlane)) {
            violations.push(`${relFile} (cli) must not import from ${targetPlane} ("${spec}")`);
          }
          if (fromPlane === "root" && !["root", "core", "server"].includes(targetPlane)) {
            violations.push(
              `${relFile} (root index) must not import from ${targetPlane} ("${spec}")`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("verifies all package.json subpath exports resolve to existing source files", () => {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as {
      license?: string;
      exports: Record<string, string | { types?: string; default?: string }>;
    };

    // admits: a published package with no licence, or one that disagrees with LICENSE.
    expect(pkgJson.license).toBe("MIT");

    for (const [subpath, target] of Object.entries(pkgJson.exports)) {
      const paths =
        typeof target === "string"
          ? [target]
          : [target.types, target.default].filter((v): v is string => Boolean(v));
      for (const relTarget of paths) {
        const absTarget = path.resolve(REPO_ROOT, relTarget);
        expect(
          fs.existsSync(absTarget),
          `Export "${subpath}" target "${relTarget}" does not exist`,
        ).toBe(true);
      }
    }
  });

  // admits: boundary-io: verifies every required markdown doc exists on disk and every relative
  // markdown link resolves; neither tsc nor ast-grep validates markdown files or links.
  it("verifies required SDK documentation files exist and relative markdown links resolve", () => {
    const requiredDocs = [
      "README.md",
      "LICENSE",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "CHANGELOG.md",
      "CLAUDE.md",
      "AGENTS.md",
      "docs/README.md",
      "docs/ARCHITECTURE.md",
      "docs/ERRORS.md",
      "docs/dev/LAYOUT.md",
      "docs/dev/RELEASING.md",
      "docs/guides/schema-and-config.md",
      "docs/guides/workers-and-routes.md",
      "docs/guides/durable-objects.md",
      "docs/guides/cli-and-http.md",
      "docs/guides/tui.md",
      "docs/guides/testing.md",
      "docs/guides/rate-limiting.md",
      "docs/guides/caching.md",
      "docs/guides/logging.md",
      "docs/guides/object-store.md",
      "docs/guides/openapi.md",
      "docs/guides/agent-telemetry.md",
      "docs/guides/agent.md",
      "docs/guides/flags.md",
      "docs/guides/telemetry.md",
    ];

    for (const docRel of requiredDocs) {
      const absDoc = path.join(REPO_ROOT, docRel);
      expect(fs.existsSync(absDoc), `Missing required documentation file: ${docRel}`).toBe(true);
    }

    const mdFiles = [
      path.join(REPO_ROOT, "README.md"),
      path.join(REPO_ROOT, "CLAUDE.md"),
      path.join(REPO_ROOT, "CONTRIBUTING.md"),
      path.join(REPO_ROOT, "SECURITY.md"),
      path.join(REPO_ROOT, "CHANGELOG.md"),
      ...walkFiles(path.join(REPO_ROOT, "docs"), ".md"),
    ];

    const brokenLinks: string[] = [];
    const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;

    for (const mdFile of mdFiles) {
      const content = fs.readFileSync(mdFile, "utf8");
      for (const match of content.matchAll(linkRe)) {
        const rawHref = match[1]?.trim() ?? "";
        if (
          !rawHref ||
          rawHref.startsWith("http://") ||
          rawHref.startsWith("https://") ||
          rawHref.startsWith("mailto:") ||
          rawHref.startsWith("#")
        ) {
          continue;
        }
        const cleanHref = rawHref.split("#")[0] ?? "";
        if (!cleanHref) continue;
        const resolved = path.resolve(path.dirname(mdFile), cleanHref);
        if (!fs.existsSync(resolved)) {
          brokenLinks.push(
            `${path.relative(REPO_ROOT, mdFile)} -> "${rawHref}" (missing ${path.relative(REPO_ROOT, resolved)})`,
          );
        }
      }
    }

    expect(brokenLinks).toEqual([]);
  });
});
