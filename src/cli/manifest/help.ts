import type {
  HeraCliHelpJson,
  HeraCliHelpJsonFlag,
  HeraCliNode,
  HeraCliProgram,
  HeraCliResolvedFlag,
  HeraCliVerbNode,
} from "./types.js";

const HELP_FLAG: HeraCliHelpJsonFlag = { name: "--help", alias: "-h", summary: "Print this usage text" };

function operandLabel(key: string, kind: string): string {
  if (kind === "required") return `<${key}>`;
  if (kind === "optional") return `[${key}]`;
  return `[${key}...]`;
}

/** The usage line: `<prog> <path> <operands> [flags]`, or the verb's own `usage` after the path. */
export function usageLine(program: HeraCliProgram, node: HeraCliNode): string {
  const head = node.path === "" ? program.name : `${program.name} ${node.path}`;
  if (node.kind === "group") return `${head} <command>`;
  if (node.spec.usage !== undefined) return `${head} ${node.spec.usage}`;
  const parts = node.operands.map((o) => operandLabel(o.key, o.spec.kind));
  const required = node.flags.filter((f) => f.spec.required).map((f) => `${f.name} <${f.spec.valueName ?? "value"}>`);
  const optional = node.flags.some((f) => !f.spec.required) ? ["[flags]"] : [];
  return [head, ...required, ...parts, ...optional].join(" ");
}

function flagNotes(f: HeraCliResolvedFlag): string {
  const notes: string[] = [];
  if (f.spec.required) notes.push("required");
  if (f.spec.repeatable) notes.push("repeatable");
  if (f.spec.choices !== undefined) notes.push(`one of ${f.spec.choices.join("|")}`);
  if (f.spec.maxLength !== undefined) notes.push(`<= ${f.spec.maxLength} chars`);
  return notes.length === 0 ? "" : ` (${notes.join(", ")})`;
}

function flagLabel(f: HeraCliResolvedFlag): string {
  const alias = f.spec.alias !== undefined ? `${f.spec.alias}, ` : "";
  const value = f.spec.kind === "boolean" ? "" : ` <${f.spec.valueName ?? "value"}>`;
  return `  ${alias}${f.name}${value}`;
}

function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length)) + 3;
  return rows.map(([label, text]) => (text.length === 0 ? label : `${label.padEnd(width)}${text}`));
}

function childRows(program: HeraCliProgram, node: HeraCliNode): (readonly [string, string])[] {
  if (node.kind !== "group") return [];
  return node.children.map((name) => {
    const child = program.nodes.get(node.path === "" ? name : `${node.path} ${name}`);
    return [`  ${name}`, child?.kind === "group" ? child.summary : (child?.spec.summary ?? "")] as const;
  });
}

function summaryOf(node: HeraCliNode): string {
  return node.kind === "group" ? node.summary : node.spec.summary;
}

/** The prose help of a path: usage, summary, commands or flags, and the example. */
export function helpText(program: HeraCliProgram, node: HeraCliNode): string {
  const lines = [`Usage: ${usageLine(program, node)}`, "", summaryOf(node)];
  const children = childRows(program, node);
  if (children.length > 0) lines.push("", "Commands:", ...table(children));
  const flagRows: (readonly [string, string])[] =
    node.kind === "verb" ? node.flags.map((f) => [flagLabel(f), `${f.spec.summary}${flagNotes(f)}`] as const) : [];
  if (node.path === "") {
    flagRows.push(["  --output <text|json>", "Output format; json is the machine rendering"]);
    if (program.version !== undefined) flagRows.push(["  --version", "Print this build's version"]);
  }
  flagRows.push(["  -h, --help", "Print this usage text"]);
  lines.push("", "Flags:", ...table(flagRows));
  if (node.kind === "verb" && node.spec.example !== undefined) lines.push("", "Example:", `  ${node.spec.example}`);
  return `${lines.join("\n")}\n`;
}

function jsonFlag(f: HeraCliResolvedFlag): HeraCliHelpJsonFlag {
  return {
    name: f.name,
    ...(f.spec.kind !== "boolean" ? { arg: f.spec.choices?.join("|") ?? f.spec.valueName ?? "value" } : {}),
    summary: `${f.spec.summary}${flagNotes(f)}`,
    ...(f.spec.repeatable ? { repeatable: true as const } : {}),
    ...(f.spec.alias !== undefined ? { alias: f.spec.alias } : {}),
  };
}

/** The `eris-help/1` document of a path; every flag carries its declared summary. */
export function helpJson(program: HeraCliProgram, node: HeraCliNode): HeraCliHelpJson {
  const commands = childRows(program, node).map(([label, summary]) => ({ name: label.trim(), summary }));
  const top: HeraCliHelpJsonFlag[] =
    node.path === ""
      ? [
          { name: "--output", arg: "text|json", summary: "Output format; json is the machine rendering" },
          { name: "--json", summary: "The same as --output json" },
          ...(program.version !== undefined ? [{ name: "--version" as const, summary: "Print this build's version" }] : []),
        ]
      : [];
  const verb = node.kind === "verb" ? (node as HeraCliVerbNode) : undefined;
  return {
    schema: "eris-help/1",
    path: node.path,
    usage: usageLine(program, node),
    summary: summaryOf(node),
    commands,
    flags: [...(verb?.flags.map(jsonFlag) ?? []), ...top, HELP_FLAG],
    ...(verb?.spec.outputSchema !== undefined ? { output_schema: verb.spec.outputSchema } : {}),
  };
}

/** Every path of the program in declaration order, the top level first. */
export function allPaths(program: HeraCliProgram): string[] {
  return [...program.nodes.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : 0));
}

/** The command reference: every path's help, for `docs` and generated pages. */
export function docsJson(program: HeraCliProgram): HeraCliHelpJson[] {
  return allPaths(program).map((path) => helpJson(program, program.nodes.get(path) as HeraCliNode));
}

/** The prose command reference: one `## <command>` section per path. */
export function docsText(program: HeraCliProgram): string {
  return allPaths(program)
    .map((path) => {
      const node = program.nodes.get(path) as HeraCliNode;
      return `## ${path === "" ? program.name : `${program.name} ${path}`}\n\n${helpText(program, node)}`;
    })
    .join("\n");
}
