import type { HeraCliRefusal, HeraCliResolvedFlag, HeraCliVerbNode } from "./types.js";

/**
 * The argv grammar, the same for every verb:
 *
 *   - `-h` / `--help` anywhere before `--` asks for help; it wins over any refusal.
 *   - `--flag` (a boolean), `--flag value` or `--flag=value` (a value flag). A value that looks like
 *     a flag (`--issue --yes`) is refused: pass it joined (`--issue=--yes`). A boolean given `=x`
 *     is refused.
 *   - A repeatable flag collects its values in order; any other flag given twice is refused.
 *   - `-y`-style aliases come from the flag's declaration.
 *   - `--` ends the flags: every later word is an operand, dash or not.
 *   - `-` alone and a negative number (`-5`) are operands.
 *   - Operands fill the declared operands in order; a word past the last is refused, and so is a
 *     missing required operand.
 *
 * Values stay strings here; the runtime decodes them against the schema the flags derive.
 */
export type HeraCliTokens =
  | { readonly _tag: "Help" }
  | { readonly _tag: "Args"; readonly raw: Readonly<Record<string, unknown>> }
  | { readonly _tag: "Refuse"; readonly refusal: HeraCliRefusal };

const NEGATIVE_NUMBER = /^-\d+(\.\d+)?$/;

function isOperandWord(word: string): boolean {
  return !word.startsWith("-") || word === "-" || NEGATIVE_NUMBER.test(word);
}

/** `--help` or `-h` before `--`. */
export function asksForHelp(argv: readonly string[]): boolean {
  for (const word of argv) {
    if (word === "--") return false;
    if (word === "--help" || word === "-h") return true;
  }
  return false;
}

/** The refusal slug prefix: the verb's own, else the path's first word. */
export function slugPrefixOf(node: HeraCliVerbNode): string {
  return node.spec.slugPrefix ?? node.path.split(" ")[0] ?? node.path;
}

export function tokenize(prog: string, node: HeraCliVerbNode, argv: readonly string[]): HeraCliTokens {
  if (asksForHelp(argv)) return { _tag: "Help" };
  const prefix = slugPrefixOf(node);
  const usage = `${prog} ${node.path}`;
  const refuse = (kind: string, what: string): HeraCliTokens => ({
    _tag: "Refuse",
    refusal: { slug: `${prefix}-${kind}`, what: `${usage}: ${what}`, fix: `${usage} --help` },
  });
  const byName = new Map<string, HeraCliResolvedFlag>();
  for (const f of node.flags) {
    byName.set(f.name, f);
    if (f.spec.alias !== undefined) byName.set(f.spec.alias, f);
  }
  const raw: Record<string, unknown> = {};
  for (const f of node.flags) {
    if (f.spec.kind === "boolean") raw[f.key] = false;
    else if (f.spec.repeatable) raw[f.key] = [];
  }
  const given = new Set<string>();
  const words: string[] = [];
  let ended = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (ended || isOperandWord(word)) {
      words.push(word);
      continue;
    }
    if (word === "--") {
      ended = true;
      continue;
    }
    const eq = word.startsWith("--") ? word.indexOf("=") : -1;
    const name = eq === -1 ? word : word.slice(0, eq);
    const f = byName.get(name);
    if (f === undefined) return refuse("unknown-flag", `unknown flag ${name}`);
    if (given.has(f.key) && !f.spec.repeatable) return refuse("duplicate-flag", `${f.name} is given twice`);
    given.add(f.key);
    if (f.spec.kind === "boolean") {
      if (eq !== -1) return refuse("unexpected-value", `${f.name} takes no value`);
      raw[f.key] = true;
      continue;
    }
    let value: string;
    if (eq !== -1) {
      value = word.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || !isOperandWord(next)) {
        return refuse("flag-missing-value", `${f.name} needs a value (join a dash-led one: ${f.name}=<value>)`);
      }
      value = next;
      i += 1;
    }
    if (f.spec.repeatable) raw[f.key] = [...(raw[f.key] as string[]), value];
    else raw[f.key] = value;
  }
  for (const f of node.flags) {
    if (f.spec.required && !given.has(f.key)) return refuse("missing-flag", `${f.name} is required`);
  }
  let at = 0;
  for (const op of node.operands) {
    if (op.spec.kind === "rest") {
      raw[op.key] = words.slice(at);
      at = words.length;
      continue;
    }
    const word = words[at];
    if (word === undefined) {
      if (op.spec.kind === "required") return refuse("missing-arg", `missing <${op.key}>`);
      continue;
    }
    raw[op.key] = word;
    at += 1;
  }
  if (at < words.length) return refuse("unexpected-arg", `unexpected argument '${words[at]}'`);
  return { _tag: "Args", raw };
}
