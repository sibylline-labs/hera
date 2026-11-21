import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** Public standards written `ABC-123`, and `ABC` itself as the placeholder; any other such label is a tracker key. */
const STANDARD_PREFIXES = new Set([
  "ABC", "RFC", "UTF", "SHA", "ISO", "CVE", "CWE", "EIP", "ERC",
  "AES", "ES", "HS", "RS", "TLS", "HTTP", "MD", "SQL", "ECMA", "ARM",
]);

/**
 * SHA-256 of each internal product name, lowercased. Hashed so this file does not list them; the
 * hashes are unsalted, so they stop an accidental listing, not a dictionary. To add a name:
 * `printf '%s' <name> | shasum -a 256`.
 */
const INTERNAL_NAME_SHA256 = new Set([
  "3aa9be6e786ce4e698147496eed7949a70e1b06d838b555662b3f669fcd6621d",
  "bf4bf68699dea329620d6575954cac45eb87f30c33c44159ffe9be879afe47d7",
  "4b8823ed9e5c2392ab4a791913bb8ce41956ea32e308b760eefb97536746dd33",
  "710482eaa280e6b7e9ed98958197686ea52772371d2374089e677ff77eae18eb",
  "69ebd5b4d828836c0ac72672eaad146b2bcf4776354a94baf9e3bc1ff99decab",
  "2c7b1ebe11c52677a549978a2a0c3d5d0dde477f4ce3b56a4d738d5dcc14d117",
  "9fbc76b5aa5a9b792b7f22cc21bfa4761e09a9eb1833fd45ca60d94bfcf4ddd1",
  "a50128d59f482a86171394eb7a2d1824df7c5d2788c4b2cbc5600ead757d5fd9",
  "d959b638663f9a7de663a1be37e39bc5d820e3dbb3a31b0af1bad43e0c39fc69",
]);

/**
 * SHA-256 of each private tracker team prefix, lowercased. An uppercase key is caught by shape
 * alone; a lowercase or mixed-case one (`abc-12` shapes are everywhere: model names, fixture ids)
 * only when its prefix is one of these.
 */
const TRACKER_PREFIX_SHA256 = new Set([
  "308373e5b224af605d8b77cb622bd6d9b095e54d75017c1708629dc68d55c691",
  "82fe032bd9337b5dfb99b28717cf8651daac73f2d319e6d6213544660b961ee7",
  "09f5ffef28309853265c4a98d0e56e1be522b6b402d8193594fd05103064fc6a",
  "a92c36e66a25ee99ff862faa8e87987be6c7cd13c3ee661c400a45b0f1e3b132",
  "c4353298d81297190fbe18652e65fb68b4dece4c5215e379a386071b2c9d169a",
  "69b4bcbc6ed36c1de44a75ce1deabd1e2e2482081d8fafcd9ef3bc115d257f92",
  "add93534eeb463800fe0ed0946048d33636dd2a014fab92e8a37f77ce98c740b",
  "aceea3feef0902bbab40e8832bf7b92c2e058348d53602e7652fc571b3b9d3ff",
  "a383bcb77c832a8ff52caace0f4efa8f1639b56b3ad5e32df3c35e8e2ca88f92",
  "9e00521370f53fe0ec983d9397348219eefdc1ab8a1e60275616bc6da340f622",
  "1143da2bc54c495c4be31d3868785d39ffdfd56df5668f0645d8f14d47647952",
  "eba1eba4c8656319ca46f67e4cd9e5718de6177d83deffa2efc9b08b9db9819c",
  "dd1181a5d67fd16436e9da762f651d1468cf49e78beac14d2c729b44ff9ab63f",
  "04ee39eacc258b9ed504db3ac77bbf76bdadb6836787118ef24a4531901042b5",
  "9bdd85331e7570288d1d5a21c2f981b0a85dbee0127d78a6b6ea38b27192e46f",
]);

type Rule = "tracker-label" | "register-label" | "private-org" | "internal-name";

const TRACKER_LABEL = /(?<![A-Za-z0-9])([A-Za-z]{2,6})-\d+(?!\d)/g;
const REGISTER_LABEL = /\b(?:PRD|NFR)-[A-Z0-9]/;
/** Built from parts so this file, which ships, does not match itself. */
const PRIVATE_ORG = new RegExp("sibylline-" + "advisory", "i");

const hashes = new Map<string, string>();
const sha256 = (token: string): string => {
  let h = hashes.get(token);
  if (h === undefined) {
    h = createHash("sha256").update(token).digest("hex");
    hashes.set(token, h);
  }
  return h;
};

/** Splits on non-alphanumerics, camelCase, a caps run before a capitalised word, and letter↔digit. */
function tokens(line: string): string[] {
  return line
    .split(/[^A-Za-z0-9]+/)
    .flatMap((w) => w.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/))
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

/** The lengths of the hashed names; a name glued to a lowercase word is a prefix or suffix of that length. */
const NAME_LENGTHS = [4, 5, 6, 7, 8];

function isName(token: string): boolean {
  return INTERNAL_NAME_SHA256.has(sha256(token)) || (token.endsWith("s") && INTERNAL_NAME_SHA256.has(sha256(token.slice(0, -1))));
}

const glued = new Map<string, boolean>();

/** A whole token, or a name glued at either end of a lowercase run (`namegateway`, `gatewayname`). */
function namesInternal(token: string): boolean {
  if (isName(token)) return true;
  let hit = glued.get(token);
  if (hit === undefined) {
    hit = NAME_LENGTHS.some(
      (n) => n < token.length && (isName(token.slice(0, n)) || isName(token.slice(-n))),
    );
    glued.set(token, hit);
  }
  return hit;
}

/** A lowercase key must end at a word edge, so a runner label such as `abc-8vcpu` is not one. */
function isTrackerKey(m: RegExpMatchArray): boolean {
  const prefix = m[1]!;
  if (prefix === prefix.toUpperCase()) return !STANDARD_PREFIXES.has(prefix);
  const next = m.input!.charAt(m.index! + m[0].length);
  return !/[A-Za-z]/.test(next) && TRACKER_PREFIX_SHA256.has(sha256(prefix.toLowerCase()));
}

/** The rules one line breaks. */
export function lineRules(line: string): Rule[] {
  const rules: Rule[] = [];
  for (const m of line.matchAll(TRACKER_LABEL)) {
    if (isTrackerKey(m)) {
      rules.push("tracker-label");
      break;
    }
  }
  if (REGISTER_LABEL.test(line)) rules.push("register-label");
  if (PRIVATE_ORG.test(line)) rules.push("private-org");
  if (tokens(line).some(namesInternal)) rules.push("internal-name");
  return rules;
}

const git = (args: string[], input?: string): string =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20, ...(input === undefined ? {} : { input }) });

const nulList = (out: string): string[] => out.split("\0").filter((s) => s.length > 0);

/** The paths `.gitattributes` marks `export-ignore`, which `git archive` leaves out of the public cut. */
function exportIgnored(paths: string[]): Set<string> {
  const fields = nulList(git(["check-attr", "-z", "--stdin", "export-ignore"], paths.join("\0") + "\0"));
  const ignored = new Set<string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === "set") ignored.add(fields[i]!);
  }
  return ignored;
}

/** Every regular file the public cut ships, from the working tree (tracked and new, minus ignored). */
function publicFiles(): string[] {
  const listed = nulList(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  const ignored = exportIgnored(listed);
  return listed.filter(
    (rel) => !ignored.has(rel) && fs.lstatSync(path.join(REPO_ROOT, rel), { throwIfNoEntry: false })?.isFile() === true,
  );
}

/** `path:line [rule]` for each hit; the path itself is line 0. Never the line text, so a CI log does not republish it. */
function scanTree(): string[] {
  const hits: string[] = [];
  for (const rel of publicFiles()) {
    for (const rule of lineRules(rel)) hits.push(`${rel}:0 [${rule}]`);
    fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const rule of lineRules(line)) hits.push(`${rel}:${i + 1} [${rule}]`);
      });
  }
  return hits;
}

/** Builds a name from its two halves, so this file never holds the literal. */
const NAME = "olym" + "pus";
const KEY = "SK" + "W-1234";
const TWO_NAMES = "Si" + "gil and Ju" + "no";

describe("public tree hygiene", () => {
  // admits: a tracker key, private register label, private-org URL or internal product name
  // landing in any shipped file, which no type or lint sees in comments, markdown or YAML.
  it("holds no tracker key, register label, private-org URL or internal name in any shipped file", () => {
    expect(scanTree()).toEqual([]);
  });

  // admits: a `.gitattributes` form that `git archive` honours but `check-attr` does not (a bare
  // `/dir export-ignore`), so the scan above skips files the cut ships, or the reverse. Both read
  // the working tree's attributes, so an uncommitted `.gitattributes` edit is held too.
  it("scans what git archive ships", () => {
    const tracked = nulList(git(["ls-tree", "-r", "-z", "--name-only", "HEAD"]));
    const ignored = exportIgnored(tracked);
    const archived = execSync("git archive --worktree-attributes --format=tar HEAD | tar -tf -", { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\n")
      .filter((p) => p.length > 0 && !p.endsWith("/"));
    expect(archived.sort()).toEqual(tracked.filter((p) => !ignored.has(p)).sort());
  });

  // admits: a rule that stops recognising a shape (a regex or splitter edit), so the tree check
  // goes green on a tree that leaks; nothing but running the rule sees that.
  it.each([
    ["a key in a comment", `// fixed (${KEY})`, "tracker-label"],
    ["a key glued to an underscore", `fix_${KEY}`, "tracker-label"],
    ["a key glued to a letter", `${KEY}b`, "tracker-label"],
    ["a lowercase key", KEY.toLowerCase(), "tracker-label"],
    ["a mixed-case key", `${KEY[0]}${KEY.slice(1).toLowerCase()}`, "tracker-label"],
    ["a register label", "(`" + "PR" + "D-HERA-D3`)", "register-label"],
    ["an NFR label", "N" + "FR-" + "OBS" + "-1", "register-label"],
    ["the private org", "github.com/sibylline-" + "advisory/x", "private-org"],
    ["a name as a word", `lifted from ${NAME}`, "internal-name"],
    ["two late-added names", TWO_NAMES, "internal-name"],
    ["a name in SNAKE_CASE", `${NAME.toUpperCase()}_LOCAL_WORKERD`, "internal-name"],
    ["a name in kebab-case", `${NAME}-gateway`, "internal-name"],
    ["a name in camelCase", `${NAME}Org`, "internal-name"],
    ["a name in PascalCase", `${NAME[0]!.toUpperCase()}${NAME.slice(1)}Tenant`, "internal-name"],
    ["a caps run before a word", `${NAME.toUpperCase()}Gateway`, "internal-name"],
    ["a name beside a digit", `${NAME}2`, "internal-name"],
    ["a plural", `${NAME}s`, "internal-name"],
    ["a possessive", `${NAME}'s alias`, "internal-name"],
    ["a name in a URL", `https://${NAME}.example.com`, "internal-name"],
    ["a name glued to a lowercase word", `const ${NAME}gateway = 1`, "internal-name"],
    ["a lowercase word glued to a name", `gateway${NAME}`, "internal-name"],
  ])("flags %s", (_name, line, rule) => {
    expect(lineRules(line)).toContain(rule);
  });

  // admits: a rule widened until it flags public standards or the public org, which would push
  // authors to delete the check; nothing but running the rule sees that.
  it.each([
    ["standards", "UTF-8, SHA-256, RFC-7807, ABC-123, AES-256, HTTP-2"],
    ["a prefix over six letters", "FAILCLOSED-1"],
    ["the public org", "@sibylline-labs/hera"],
    ["an ordinary word", "Canonical 26-character ULID"],
    ["lowercase word-number ids", "gemma-3, org-1, yak-2, utf-8"],
    ["a runner label", `${KEY.split("-")[0]!.toLowerCase()}-8vcpu`],
  ])("does not flag %s", (_name, line) => {
    expect(lineRules(line)).toEqual([]);
  });
});
