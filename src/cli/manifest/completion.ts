import { domainFunction, shellIdent } from "./words.js";
import type { HeraCliCompleteWord, HeraCliProgram, HeraCliVerbNode } from "./types.js";

export type HeraCliShell = "bash" | "zsh";

const quote = (path: string): string => `"${path}"`;

function verbs(program: HeraCliProgram): HeraCliVerbNode[] {
  return [...program.nodes.values()].filter((n): n is HeraCliVerbNode => n.kind === "verb");
}

/** The `COMPREPLY` line for a slot's words, or none when the slot offers nothing. */
function reply(prog: string, words: readonly HeraCliCompleteWord[] | undefined, helpers: Map<string, true>): string | undefined {
  if (words === undefined || words.length === 0) return undefined;
  if (words.includes("@file")) return `COMPREPLY=( $(compgen -f -- "$cur") )`;
  const parts: string[] = [];
  const literals = words.filter((w): w is string => typeof w === "string");
  if (literals.length > 0) parts.push(literals.join(" "));
  for (const w of words) {
    if (typeof w === "string") continue;
    for (const lib of w.library ?? []) helpers.set(lib.trim(), true);
    helpers.set(w.helper.trim(), true);
    parts.push(`$(${domainFunction(prog, w.domain)})`);
  }
  return `COMPREPLY=( $(compgen -W "${parts.join(" ")}" -- "$cur") )`;
}

function caseBlock(fn: string, arms: readonly string[], fallback: string): string {
  return [`${fn}() {`, '  case "$1" in', ...arms, `    *) ${fallback} ;;`, "  esac", "}"].join("\n");
}

/** The shared body: lookup functions as `case` tables (bash 3.2: no associative arrays). */
function body(program: HeraCliProgram): string {
  const id = shellIdent(program.name);
  const helpers = new Map<string, true>();
  const subs: string[] = [];
  for (const node of program.nodes.values()) {
    if (node.kind === "group") subs.push(`    ${quote(node.path)}) echo "${node.children.join(" ")}" ;;`);
  }
  const flags: string[] = [];
  const valued: string[] = [];
  const values: string[] = [];
  const operands: string[] = [];
  for (const node of verbs(program)) {
    const names = node.flags.flatMap((f) => [f.name, ...(f.spec.alias !== undefined ? [f.spec.alias] : [])]);
    flags.push(`    ${quote(node.path)}) echo "${[...names, "--help"].join(" ")}" ;;`);
    for (const f of node.flags) {
      if (f.spec.kind === "boolean") continue;
      const keys = [f.name, ...(f.spec.alias !== undefined ? [f.spec.alias] : [])].map((n) => quote(`${node.path} ${n}`));
      valued.push(`    ${keys.join("|")}) return 0 ;;`);
      const line = reply(program.name, f.spec.completeValue, helpers);
      if (line !== undefined) values.push(`    ${keys.join("|")}) ${line} ;;`);
    }
    node.operands.forEach((op, i) => {
      const line = reply(program.name, op.spec.complete, helpers);
      if (line === undefined) return;
      const key = op.spec.kind === "rest" ? `"${node.path}|"*` : quote(`${node.path}|${i}`);
      operands.push(`    ${key}) ${line} ;;`);
    });
  }
  return [
    ...helpers.keys(),
    caseBlock(`__${id}_subs`, subs, "return 1"),
    caseBlock(`__${id}_flags`, flags, "return 1"),
    caseBlock(`__${id}_valued`, valued, "return 1"),
    caseBlock(`__${id}_values`, values, "return 1"),
    caseBlock(`__${id}_operand`, operands, "return 1"),
    `_${id}_complete() {
  [ -n "\${ZSH_VERSION:-}" ] && setopt localoptions ksharrays
  local cur="\${COMP_WORDS[COMP_CWORD]}" path="" i=1 n=0 w subs ended=0
  COMPREPLY=()
  while [ "$i" -lt "$COMP_CWORD" ]; do
    w="\${COMP_WORDS[i]}"
    subs="$(__${id}_subs "$path")" || break
    case " $subs " in *" $w "*) path="\${path:+$path }$w"; i=$((i + 1)) ;; *) break ;; esac
  done
  if subs="$(__${id}_subs "$path")"; then
    case "$cur" in -*) COMPREPLY=( $(compgen -W "--help" -- "$cur") ) ;; *) COMPREPLY=( $(compgen -W "$subs" -- "$cur") ) ;; esac
    return 0
  fi
  while [ "$i" -lt "$COMP_CWORD" ]; do
    w="\${COMP_WORDS[i]}"
    if [ "$ended" = 1 ]; then n=$((n + 1))
    elif [ "$w" = "--" ]; then ended=1
    else case "$w" in
      -?*) case "$w" in *=*) ;; *) if __${id}_valued "$path $w"; then i=$((i + 1)); fi ;; esac ;;
      *) n=$((n + 1)) ;;
    esac; fi
    i=$((i + 1))
  done
  w="\${COMP_WORDS[COMP_CWORD - 1]}"
  if [ "$ended" = 0 ] && [ "$COMP_CWORD" -gt 1 ] && __${id}_valued "$path $w"; then
    __${id}_values "$path $w"
    return 0
  fi
  case "$cur" in
    -*) [ "$ended" = 0 ] && COMPREPLY=( $(compgen -W "$(__${id}_flags "$path")" -- "$cur") ) ;;
    *) __${id}_operand "$path|$n" ;;
  esac
  return 0
}`,
  ].join("\n\n");
}

/**
 * The tab-completion script for `shell`, derived from the composed manifest alone: deterministic
 * (the same program emits the same bytes) and loading no handler.
 */
export function completionScript(program: HeraCliProgram, shell: HeraCliShell): string {
  const id = shellIdent(program.name);
  const head = `# ${program.name} ${shell} completion, generated from its command manifest. Source it from your shell rc:\n#   eval "$(${program.name} completion ${shell})"`;
  const zshPrelude = "autoload -U +X bashcompinit && bashcompinit";
  const register = `complete -F _${id}_complete ${program.name}`;
  return `${[head, ...(shell === "zsh" ? [zshPrelude] : []), body(program), register].join("\n\n")}\n`;
}
