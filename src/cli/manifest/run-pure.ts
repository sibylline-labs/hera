import { completionScript } from "./completion.js";
import { docsJson, docsText, helpJson, helpText } from "./help.js";
import { type HeraCliOutputMode, parseGlobals, route } from "./route.js";
import { tokenize } from "./tokenize.js";
import type { HeraCliProgram, HeraCliRefusal, HeraCliVerbNode } from "./types.js";

export interface HeraCliPureIo {
  readonly stdout: (text: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * What `runPure` did with a command line:
 * - `Done`: it answered (help, help-json, `--version`, `completion`, `docs`) and wrote stdout.
 * - `Refuse`: the line is malformed; the runtime renders the refusal (exit 2).
 * - `Dispatch`: a plugin verb with its tokenized args; the runtime decodes and runs it.
 */
export type HeraCliPureOutcome =
  | { readonly _tag: "Done"; readonly code: 0 }
  | { readonly _tag: "Refuse"; readonly refusal: HeraCliRefusal; readonly mode: HeraCliOutputMode }
  | {
      readonly _tag: "Dispatch";
      readonly node: HeraCliVerbNode;
      readonly raw: Readonly<Record<string, unknown>>;
      readonly mode: HeraCliOutputMode;
    };

const done = { _tag: "Done", code: 0 } as const;

/**
 * Answers every command line the manifest alone can answer, loading no handler and no `effect`.
 * A binary's entry calls it first and imports the runtime only on `Dispatch` or `Refuse`, which
 * keeps `--help` and `completion` within the cold-start budget.
 */
export function runPure(program: HeraCliProgram, argv: readonly string[], io: HeraCliPureIo): HeraCliPureOutcome {
  const globals = parseGlobals(program.name, argv, io.env);
  if (globals._tag === "Refuse") return { _tag: "Refuse", refusal: globals.refusal, mode: "text" };
  const { mode } = globals;
  const routed = route(program, globals.argv);
  switch (routed._tag) {
    case "Refuse":
      return { _tag: "Refuse", refusal: routed.refusal, mode };
    case "Version":
      io.stdout(mode === "json" ? `${JSON.stringify({ name: program.name, version: program.version })}\n` : `${program.name} ${program.version}\n`);
      return done;
    case "Help":
      io.stdout(mode === "json" ? `${JSON.stringify(helpJson(program, routed.node))}\n` : helpText(program, routed.node));
      return done;
    case "Verb":
      break;
  }
  const { node } = routed;
  const tokens = tokenize(program.name, node, routed.rest);
  if (tokens._tag === "Help") {
    io.stdout(mode === "json" ? `${JSON.stringify(helpJson(program, node))}\n` : helpText(program, node));
    return done;
  }
  if (tokens._tag === "Refuse") return { _tag: "Refuse", refusal: tokens.refusal, mode };
  if (mode === "json" && !node.spec.json) {
    return {
      _tag: "Refuse",
      mode: "text",
      refusal: {
        slug: "output-json-unsupported",
        what: `${program.name} ${node.path} has no --output json rendering`,
        fix: `${program.name} ${node.path} --help     shows what it prints`,
      },
    };
  }
  switch (node.builtin) {
    case "completion-bash":
      io.stdout(completionScript(program, "bash"));
      return done;
    case "completion-zsh":
      io.stdout(completionScript(program, "zsh"));
      return done;
    case "docs":
      io.stdout(mode === "json" ? `${JSON.stringify(docsJson(program))}\n` : docsText(program));
      return done;
    case undefined:
      return { _tag: "Dispatch", node, raw: tokens.raw, mode };
  }
}
