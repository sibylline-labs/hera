/**
 * The workflows keep the posture a public repository's release pipeline needs.
 * Read from the parsed YAML, not by eye: a release job that quietly gains write
 * access, an action that floats on a tag, or a secret read outside the intended
 * job is how a compromised dependency publishes a package every consumer installs.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly with?: Readonly<Record<string, string | boolean | number>>;
}

interface Job {
  readonly name?: string;
  readonly needs?: string | ReadonlyArray<string>;
  readonly "runs-on"?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly if?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly steps: ReadonlyArray<Step>;
}

interface Workflow {
  readonly name?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, Job>>;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const workflowFiles = fs
  .readdirSync(WORKFLOWS_DIR)
  .filter((name) => name.endsWith(".yml"))
  .sort();

const parsedCache = new Map<string, Workflow>();

function readWorkflow(filename: string): Workflow {
  const cached = parsedCache.get(filename);
  if (cached !== undefined) return cached;
  const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, filename), "utf8");
  const json = execFileSync(
    "bun",
    ["-e", "process.stdout.write(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))"],
    { input: raw, encoding: "utf8" },
  );
  const parsed = JSON.parse(json) as Workflow;
  parsedCache.set(filename, parsed);
  return parsed;
}

describe("GitHub Actions workflow security posture", () => {
  // admits: boundary-io: workflow YAML filenames and job graphs are unchecked by tsc or ast-grep;
  // a missing or renamed workflow or release job would silently skip downstream assertions.
  it("finds ci.yml and release.yml with the expected release job graph", () => {
    expect(workflowFiles).toEqual(expect.arrayContaining(["ci.yml", "release.yml"]));
    expect(Object.keys(readWorkflow("release.yml").jobs)).toEqual(["plan", "verify", "publish", "npm"]);
  });

  // admits: boundary-io: a floating action tag or branch lets upstream ref changes execute code
  // inside CI or release jobs; neither tsc nor ast-grep parses GitHub Actions YAML.
  it.each(workflowFiles)("%s pins every action to a full 40-hex commit SHA", (filename) => {
    const uses = Object.values(readWorkflow(filename).jobs).flatMap((job) =>
      job.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      expect(ref, `${filename}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  // admits: boundary-io: widening top-level workflow permissions grants write scopes to every job,
  // including jobs that run repository tests; workflow YAML has no type checker.
  it.each(workflowFiles)("%s defaults top-level permissions to read-only contents", (filename) => {
    expect(readWorkflow(filename).permissions).toEqual({ contents: "read" });
  });

  // admits: boundary-io: granting contents:write to verify or id-token:write to any job that runs
  // repo code lets untrusted code alter releases or mint an npm OIDC publish token.
  it("grants write permissions only to publish (contents) and npm (id-token) in release.yml", () => {
    const release = readWorkflow("release.yml");
    const scoped = Object.entries(release.jobs).flatMap(([name, job]) =>
      job.permissions === undefined ? [] : [[name, job.permissions] as const],
    );
    const writesOnly = (perms: Readonly<Record<string, string>>) =>
      Object.fromEntries(Object.entries(perms).filter(([, level]) => level === "write"));

    expect(
      scoped
        .filter(([, perms]) => Object.values(perms).includes("write"))
        .map(([name, perms]) => [name, writesOnly(perms)]),
    ).toEqual([
      ["publish", { contents: "write" }],
      ["npm", { "id-token": "write" }],
    ]);
    expect(
      scoped.flatMap(([, perms]) => Object.values(perms)).every((v) => v === "read" || v === "write"),
    ).toBe(true);
  });

  // admits: boundary-io: reading any secret re-introduces long-lived tokens against OIDC trusted
  // publishing, and referencing secrets in an `if` expression causes GitHub Actions to reject the file.
  it("reads no secrets and references no secrets in any if expression across workflows", () => {
    for (const filename of workflowFiles) {
      const workflow = readWorkflow(filename);
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        const secretRefs = [...JSON.stringify(job).matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
        expect({ filename, jobName, secretRefs }).toEqual({ filename, jobName, secretRefs: [] });
        for (const cond of [job.if, ...job.steps.map((s) => s.if)]) {
          expect(cond ?? "").not.toContain("secrets.");
        }
      }
    }
  });

  // admits: boundary-io: without gating plan on !github.event.repository.private, pushing a tag to
  // a private mirror triggers release jobs intended only for the public repository.
  it("gates release.yml off on private repositories", () => {
    const plan = readWorkflow("release.yml").jobs.plan;
    expect(plan).toBeDefined();
    expect(plan?.if ?? "").toContain("!github.event.repository.private");
  });

  // admits: boundary-io: self-hosted runners, Node < 24, registry-url auth tokens, running repo code
  // inside the OIDC job, or dry-run ordering mistakes break trusted publishing or leak OIDC tokens.
  it("configures the npm job for OIDC trusted publishing without tokens or repo code", () => {
    const npm = readWorkflow("release.yml").jobs.npm;
    expect(npm).toBeDefined();
    if (npm === undefined) return;

    const needs = Array.isArray(npm.needs) ? [...npm.needs].sort() : npm.needs === undefined ? [] : [npm.needs];
    expect(needs).toEqual(["plan", "publish", "verify"]);
    expect(npm.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(npm["runs-on"]).toMatch(/^(ubuntu|macos|windows)-[\w.-]+$/);

    const serialized = JSON.stringify(npm);
    for (const banned of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "_authToken", "registry-url", "--userconfig"]) {
      expect({ banned, found: serialized.includes(banned) }).toEqual({ banned, found: false });
    }

    const setupNode = npm.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(setupNode?.with?.["node-version"]).toBe("24");
    expect(setupNode?.with?.["package-manager-cache"]).toBe(false);

    const runSteps = npm.steps.flatMap((s) => (s.run === undefined ? [] : [s.run]));
    expect(runSteps.length).toBeGreaterThan(0);
    for (const script of runSteps) {
      expect(/\b(bun|node|npx)\b/.test(script), script).toBe(false);
      for (const line of script
        .split("\n")
        .filter((l) => /\bnpm (publish|version|view|pack|install|ci|run)\b/.test(l))) {
        expect(line).toContain("--ignore-scripts");
      }
    }

    const versionStep = npm.steps.find((s) => /\bnpm version\b/.test(s.run ?? ""));
    expect(versionStep?.run ?? "").toContain("--no-git-tag-version");
    expect(versionStep?.run ?? "").toContain("--allow-same-version");

    const viewIdx = npm.steps.findIndex((s) => /\bnpm view\b/.test(s.run ?? ""));
    const dryIdx = npm.steps.findIndex((s) => /\bnpm publish\b.*--dry-run/.test(s.run ?? ""));
    const realIdx = npm.steps.findIndex((s) => /\bnpm publish\b(?!.*--dry-run)/.test(s.run ?? ""));
    expect(viewIdx).toBeGreaterThan(-1);
    expect(dryIdx).toBeGreaterThan(viewIdx);
    expect(realIdx).toBeGreaterThan(dryIdx);
    expect(npm.steps[realIdx]?.run ?? "").toContain("--access public");
  });

  // admits: algorithmic: the shell regex inside release.yml plan must accept valid vMAJOR.MINOR.PATCH
  // tags (including prereleases) and reject bare versions, malformed prereleases, and >9-digit segments.
  it("validates release tags against the documented vMAJOR.MINOR.PATCH[-prerelease] grammar", () => {
    const plan = readWorkflow("release.yml").jobs.plan;
    const step = plan?.steps.find((s) => s.run?.includes("=~"));
    expect(step?.run).toBeDefined();
    const match = /=~ (\^.*\$) \]\]/.exec(step?.run ?? "");
    expect(match?.[1]).toBeDefined();
    const regex = new RegExp(match?.[1] ?? "");

    const valid = [
      "v0.2.0",
      "v0.2.1",
      "v10.20.30",
      "v0.3.0-rc.1",
      "v1.0.0-alpha-1",
      "v1.0.0-0.3.7",
      "v999999999.0.0",
    ];
    const invalid = [
      "0.2.0",
      "v0.2",
      "v0.2.0.1",
      "v0.2.0-",
      "v0.2.0-rc.",
      "v0.2.0-rc..1",
      "v0.2.0-.rc",
      "v1000000000.0.0",
      "v0.2.0+build",
      "v0.2.0-rc_1",
      "latest",
    ];

    for (const tag of valid) expect(regex.test(tag), `expected valid: ${tag}`).toBe(true);
    for (const tag of invalid) expect(regex.test(tag), `expected invalid: ${tag}`).toBe(false);
  });
});
