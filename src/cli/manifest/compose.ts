import { flagNameOf } from "./flag.js";
import { checkCompleteWords } from "./words.js";
import type {
  HeraCliCommand,
  HeraCliExtensionSpec,
  HeraCliNode,
  HeraCliPluginSpec,
  HeraCliProgram,
  HeraCliResolvedFlag,
  HeraCliResolvedOperand,
  HeraCliVerbNode,
  HeraCliVerbSpec,
} from "./types.js";

/** A manifest that cannot compose: thrown at build time, naming the plugin and path. */
export class HeraCliManifestError extends Error {
  override readonly name = "HeraCliManifestError";
}

export interface ComposeProgramConfig {
  /** The binary's name (`eris`); lower-case letters, digits and `-`. */
  readonly name: string;
  readonly summary?: string | undefined;
  readonly version?: string | undefined;
  readonly plugins: readonly HeraCliPluginSpec[];
  /** Add the `completion bash|zsh` group and the `docs` verb (default `true`). */
  readonly builtins?: boolean | undefined;
}

const WORD = /^[a-z][a-z0-9-]*$/;
const FLAG_KEY = /^[a-z][a-zA-Z0-9]*$/;
const ALIAS = /^-[a-zA-Z]$/;
const RESERVED = new Set(["--help", "--output", "--json", "--version"]);

const noHandler = (): never => {
  throw new HeraCliManifestError("built-in verbs answer in runPure and load no handler");
};

function builtinVerb(summary: string, json: boolean): HeraCliVerbSpec {
  return { _tag: "HeraCliVerb", summary, flags: {}, operands: {}, json, load: noHandler };
}

function builtinPlugin(): HeraCliPluginSpec {
  return {
    _tag: "HeraCliPlugin",
    name: "hera-builtins",
    commands: {
      completion: {
        _tag: "HeraCliGroup",
        summary: "Emit the shell tab-completion script (bash, zsh)",
        commands: {
          bash: builtinVerb("Emit the bash completion script", false),
          zsh: builtinVerb("Emit the zsh completion script", false),
        },
      },
      docs: builtinVerb("Print the command reference: every command, its flags and summary", true),
    },
  };
}

const BUILTIN_TAG: Readonly<Record<string, HeraCliVerbNode["builtin"]>> = {
  "completion bash": "completion-bash",
  "completion zsh": "completion-zsh",
  docs: "docs",
};

function resolveFlags(
  where: string,
  flags: HeraCliVerbSpec["flags"],
  extension: string | undefined,
  prog: string,
): HeraCliResolvedFlag[] {
  return Object.entries(flags).map(([key, spec]) => {
    if (!FLAG_KEY.test(key)) throw new HeraCliManifestError(`${where}: flag key '${key}' is not camelCase`);
    const name = flagNameOf(key);
    if (RESERVED.has(name)) throw new HeraCliManifestError(`${where}: ${name} is reserved by the host`);
    if (spec.alias !== undefined && (!ALIAS.test(spec.alias) || spec.alias === "-h")) {
      throw new HeraCliManifestError(`${where}: alias '${spec.alias}' must be one letter, not -h`);
    }
    if (spec.repeatable && spec.kind !== "string") {
      throw new HeraCliManifestError(`${where}: only a string flag may repeat (${name})`);
    }
    checkCompleteWords(`${where} ${name}`, spec.completeValue, prog, (m) => new HeraCliManifestError(m));
    return { key, name, spec, extension };
  });
}

function resolveOperands(where: string, spec: HeraCliVerbSpec, prog: string): HeraCliResolvedOperand[] {
  const out = Object.entries(spec.operands).map(([key, op]) => ({ key, spec: op }));
  out.forEach((op, i) => {
    if (op.spec.kind === "rest" && i !== out.length - 1) {
      throw new HeraCliManifestError(`${where}: rest operand '${op.key}' must be last`);
    }
    const prev = out[i - 1];
    if (op.spec.kind === "required" && prev !== undefined && prev.spec.kind !== "required") {
      throw new HeraCliManifestError(`${where}: required operand '${op.key}' follows an optional one`);
    }
    checkCompleteWords(`${where} <${op.key}>`, op.spec.complete, prog, (m) => new HeraCliManifestError(m));
  });
  return out;
}

function checkUnique(where: string, flags: readonly HeraCliResolvedFlag[], operands: readonly HeraCliResolvedOperand[]): void {
  const seen = new Set<string>();
  for (const label of [...flags.flatMap((f) => [f.name, f.key, ...(f.spec.alias ? [f.spec.alias] : [])]), ...operands.map((o) => o.key)]) {
    if (seen.has(label)) throw new HeraCliManifestError(`${where}: '${label}' is declared twice`);
    seen.add(label);
  }
}

function addCommand(
  nodes: Map<string, HeraCliNode>,
  prog: string,
  plugin: string,
  path: string,
  command: HeraCliCommand,
): void {
  const word = path.slice(path.lastIndexOf(" ") + 1);
  if (!WORD.test(word)) throw new HeraCliManifestError(`plugin ${plugin}: command '${word}' is not lower-case kebab`);
  if (nodes.has(path)) throw new HeraCliManifestError(`plugin ${plugin}: '${path}' is declared twice`);
  if (command._tag === "HeraCliGroup") {
    const children = Object.keys(command.commands);
    if (children.length === 0) throw new HeraCliManifestError(`plugin ${plugin}: group '${path}' has no commands`);
    nodes.set(path, { kind: "group", path, summary: command.summary, children });
    for (const [child, sub] of Object.entries(command.commands)) addCommand(nodes, prog, plugin, `${path} ${child}`, sub);
    return;
  }
  const where = `plugin ${plugin}: ${path}`;
  const flags = resolveFlags(where, command.flags, undefined, prog);
  const operands = resolveOperands(where, command, prog);
  checkUnique(where, flags, operands);
  nodes.set(path, {
    kind: "verb",
    path,
    plugin,
    spec: command,
    flags,
    operands,
    extensions: [],
    builtin: plugin === "hera-builtins" ? BUILTIN_TAG[path] : undefined,
  });
}

function applyExtension(
  nodes: Map<string, HeraCliNode>,
  prog: string,
  plugin: string,
  path: string,
  ext: HeraCliExtensionSpec,
): void {
  const target = nodes.get(path);
  if (target === undefined || target.kind !== "verb" || target.builtin !== undefined) {
    throw new HeraCliManifestError(`plugin ${plugin}: extends '${path}', which is not a plugin verb`);
  }
  const where = `plugin ${plugin}: extension of ${path}`;
  const flags = [...target.flags, ...resolveFlags(where, ext.flags, plugin, prog)];
  checkUnique(where, flags, target.operands);
  nodes.set(path, { ...target, flags, extensions: [...target.extensions, { plugin, spec: ext }] });
}

/**
 * Composes plugins into a program: every command path and its node, extensions merged into their
 * target verbs. Pure and build-time: throws `HeraCliManifestError` on any inconsistency.
 */
export function composeProgram(config: ComposeProgramConfig): HeraCliProgram {
  if (!WORD.test(config.name)) throw new HeraCliManifestError(`program name '${config.name}' is not lower-case kebab`);
  const plugins = config.builtins === false ? config.plugins : [builtinPlugin(), ...config.plugins];
  const names = new Set<string>();
  const nodes = new Map<string, HeraCliNode>();
  const top: string[] = [];
  for (const plugin of plugins) {
    if (names.has(plugin.name)) throw new HeraCliManifestError(`plugin '${plugin.name}' is composed twice`);
    names.add(plugin.name);
    for (const [word, command] of Object.entries(plugin.commands)) {
      addCommand(nodes, config.name, plugin.name, word, command);
      top.push(word);
    }
  }
  for (const plugin of plugins) {
    for (const [path, ext] of Object.entries(plugin.extends ?? {})) applyExtension(nodes, config.name, plugin.name, path, ext);
  }
  nodes.set("", {
    kind: "group",
    path: "",
    summary: config.summary ?? "The commands this build composes; each answers --help",
    children: top,
  });
  return { _tag: "HeraCliProgram", name: config.name, summary: config.summary ?? "", version: config.version, nodes };
}
