import * as Redacted from "effect/Redacted";
import { type RedactionClass, SCRUB_RULES } from "./scrub-rules.js";

export { REDACTION_CLASSES, type RedactionClass } from "./scrub-rules.js";

export interface ScrubFreeTextResult {
  readonly text: string;
  readonly redactions: ReadonlyArray<RedactionClass>;
}

/** Expands `$1`-style references against a replacer's `(full, ...groups, offset, input)` args. */
function expandGroups(template: string, args: ReadonlyArray<string>): string {
  const groups = args.slice(1, -2);
  return template.replace(/\$(\d)/g, (_, n: string) => groups[Number(n) - 1] ?? "");
}

function scrubPass(text: string, hitSet: Set<RedactionClass>): string {
  let out = text;
  for (const rule of SCRUB_RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    const replace = rule.replace;
    out = out.replace(regex, (...args: string[]) => {
      const full = args[0] ?? "";
      const res =
        typeof replace === "string" ? expandGroups(replace, args) : replace(...args);
      if (res !== full) hitSet.add(rule.cls);
      return res;
    });
  }
  return out;
}

/**
 * Scrubs free-text diagnostic strings across the 13 credential classes in `scrub-rules.ts`.
 * One pass over the table; scrubbing the output again returns it unchanged with no redactions.
 *
 * Also handles `Redacted<T>` values safely without ever unwrapping them.
 */
export function scrubFreeText(input: unknown): ScrubFreeTextResult {
  if (Redacted.isRedacted(input)) {
    return { text: "<redacted>", redactions: ["assignment"] };
  }
  const source = typeof input === "string" ? input : String(input ?? "");
  if (source.length === 0) {
    return { text: "", redactions: [] };
  }

  const hitSet = new Set<RedactionClass>();
  const out = scrubPass(source, hitSet);

  return { text: out, redactions: Array.from(hitSet) };
}
