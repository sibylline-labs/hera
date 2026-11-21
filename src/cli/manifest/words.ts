import type { HeraCliCompleteWord, HeraCliCompletionDomain } from "./types.js";

/** Characters a literal completion word may hold: shell-safe in `compgen -W` and zsh. */
const LITERAL = /^[A-Za-z0-9._:/=+,%-]+$/;
const DOMAIN = /^@[a-z0-9_]+$/;

/** `eris-x` → `eris_x`, the shell identifier prefix of a program's functions. */
export function shellIdent(prog: string): string {
  return prog.replace(/-/g, "_");
}

/** The function a domain's helper must define: `__<prog>_dom_<name>`. */
export function domainFunction(prog: string, domain: HeraCliCompletionDomain["domain"]): string {
  return `__${shellIdent(prog)}_dom_${domain.slice(1)}`;
}

/** `name()` or `function name` opens a definition of `name` in the helper text. */
function defines(text: string, fn: string): boolean {
  return new RegExp(`(^|\\n)\\s*(function\\s+)?${fn}\\s*\\(\\)`).test(text);
}

/**
 * Checks completion words at composition, so a bad word fails the build rather than breaking
 * (or running code in) every shell that sources the script.
 */
export function checkCompleteWords(
  where: string,
  words: readonly HeraCliCompleteWord[] | undefined,
  prog: string,
  fail: (message: string) => Error,
): void {
  for (const word of words ?? []) {
    if (typeof word === "string") {
      if (word === "@file") continue;
      if (!LITERAL.test(word)) throw fail(`${where}: completion word '${word}' is not shell-safe`);
      continue;
    }
    if (!DOMAIN.test(word.domain) || word.domain === "@file") {
      throw fail(`${where}: completion domain '${word.domain}' must be @ then [a-z0-9_]`);
    }
    const fn = domainFunction(prog, word.domain);
    if (!defines(word.helper, fn)) throw fail(`${where}: domain ${word.domain} helper must define ${fn}()`);
    for (const lib of word.library ?? []) {
      if (!new RegExp(`(^|\\n)\\s*(function\\s+)?__${shellIdent(prog)}_dom_[a-z0-9_]+\\s*\\(\\)`).test(lib)) {
        throw fail(`${where}: domain ${word.domain} library text must define a __${shellIdent(prog)}_dom_* function`);
      }
    }
  }
}
