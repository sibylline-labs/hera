import { asksForHelp } from "./tokenize.js";
import type { HeraCliNode, HeraCliProgram, HeraCliRefusal, HeraCliVerbNode } from "./types.js";

export type HeraCliOutputMode = "text" | "json";

export type HeraCliGlobals =
  | { readonly _tag: "Ok"; readonly mode: HeraCliOutputMode; readonly argv: readonly string[] }
  | { readonly _tag: "Refuse"; readonly refusal: HeraCliRefusal };

/**
 * The global pre-pass: `--output text|json` (or `--output=…`) and `--json` (an alias of
 * `--output json`) are read anywhere before `--` and removed. `--json` with `--output text` is
 * refused, and so is any other `--output` value.
 */
export function parseGlobals(
  prog: string,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): HeraCliGlobals {
  const out: string[] = [];
  let output: string | undefined;
  let json = false;
  let ended = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (ended) {
      out.push(word);
    } else if (word === "--") {
      ended = true;
      out.push(word);
    } else if (word === "--json") {
      json = true;
    } else if (word === "--output") {
      output = argv[i + 1] ?? "";
      i += 1;
    } else if (word.startsWith("--output=")) {
      output = word.slice("--output=".length);
    } else {
      out.push(word);
    }
  }
  const fix = `${prog} --output json <command>     machine rendering (JSON on stdout)\n${prog} --output text <command>     human rendering (the default)`;
  if (output !== undefined && output !== "text" && output !== "json") {
    return { _tag: "Refuse", refusal: { slug: "output-format-unknown", what: `--output takes 'text' or 'json'`, fix } };
  }
  if (json && output === "text") {
    return { _tag: "Refuse", refusal: { slug: "output-format-conflict", what: "--json asks for --output json, and --output text was given too", fix } };
  }
  const envJson = env.ERIS_OUTPUT?.toLowerCase() === "json" && output === undefined;
  return { _tag: "Ok", mode: json || output === "json" || envJson ? "json" : "text", argv: out };
}

export type HeraCliRoute =
  | { readonly _tag: "Help"; readonly node: HeraCliNode }
  | { readonly _tag: "Version" }
  | { readonly _tag: "Verb"; readonly node: HeraCliVerbNode; readonly rest: readonly string[] }
  | { readonly _tag: "Refuse"; readonly refusal: HeraCliRefusal };

/** The child path of `path` named `word`, when one exists. */
function childOf(program: HeraCliProgram, path: string, word: string): HeraCliNode | undefined {
  return program.nodes.get(path === "" ? word : `${path} ${word}`);
}

/**
 * Routes argv (globals stripped) to a node. Leading words walk the group tree; a bare group or a
 * help token answers help; a word no group holds is refused.
 */
export function route(program: HeraCliProgram, argv: readonly string[]): HeraCliRoute {
  const root = program.nodes.get("");
  if (root === undefined || root.kind !== "group") throw new Error("program has no root group");
  if (argv.length === 1 && argv[0] === "--version" && program.version !== undefined) return { _tag: "Version" };
  let node: HeraCliNode = root;
  let i = 0;
  while (node.kind === "group") {
    const word = argv[i];
    if (word === undefined || word === "--help" || word === "-h") return { _tag: "Help", node };
    const next = childOf(program, node.path, word);
    if (next === undefined) {
      if (asksForHelp(argv.slice(i))) return { _tag: "Help", node };
      const where = node.path === "" ? program.name : `${program.name} ${node.path}`;
      const prefix = node.path === "" ? program.name : (node.path.split(" ")[0] ?? program.name);
      return {
        _tag: "Refuse",
        refusal: {
          slug: `${prefix}-unknown-command`,
          what: `${where}: unknown command '${word}'`,
          fix: `${where} --help     lists the commands`,
        },
      };
    }
    node = next;
    i += 1;
  }
  return { _tag: "Verb", node, rest: argv.slice(i) };
}
