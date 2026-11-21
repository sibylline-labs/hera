/**
 * The data shapes of a CLI manifest: one declaration per verb, from which routing, argv decoding,
 * help, help-json, docs and completion derive. Pure data: this sub-plane imports only its siblings,
 * so help and completion load no handler module and no `effect`.
 */

/** A completion slot a shell function fills at tab-press time (`__<prog>_dom_<name>`). */
export interface HeraCliCompletionDomain {
  /** `@` then lower-case letters, digits or `_`; `@file` is built in. */
  readonly domain: `@${string}`;
  /** Shell text, bash-3.2 clean, defining exactly the function `__<prog>_dom_<name>`. */
  readonly helper: string;
  /** Functions the helper calls, each its own `__<prog>_dom_…` definition; emitted once. */
  readonly library?: readonly string[] | undefined;
}

/** One completion word: a literal, `@file` (file names), or a domain. */
export type HeraCliCompleteWord = string | HeraCliCompletionDomain;

export type HeraCliFlagKind = "boolean" | "string" | "number";

/** A flag's declaration; `V` is the decoded value type the handler reads. */
export interface HeraCliFlag<V = unknown> {
  readonly _tag: "HeraCliFlag";
  readonly kind: HeraCliFlagKind;
  readonly summary: string;
  readonly alias?: `-${string}` | undefined;
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly choices?: readonly string[] | undefined;
  readonly maxLength?: number | undefined;
  readonly int?: boolean | undefined;
  /** The value's name in help (`<id|name>`); default `value`. */
  readonly valueName?: string | undefined;
  /** Words tab completion offers for the value. */
  readonly completeValue?: readonly HeraCliCompleteWord[] | undefined;
  /** Phantom: the decoded value type. Never set at runtime. */
  readonly "~value"?: (() => V) | undefined;
}

export type HeraCliOperandKind = "required" | "optional" | "rest";

/** A positional operand's declaration; `V` is its decoded type. */
export interface HeraCliOperand<V = unknown> {
  readonly _tag: "HeraCliOperand";
  readonly kind: HeraCliOperandKind;
  readonly summary: string;
  readonly complete?: readonly HeraCliCompleteWord[] | undefined;
  readonly "~value"?: (() => V) | undefined;
}

export type HeraCliFlags = Readonly<Record<string, HeraCliFlag>>;
export type HeraCliOperands = Readonly<Record<string, HeraCliOperand>>;

type ValueOf<T> = T extends { readonly "~value"?: (() => infer V) | undefined } ? V : never;

/** The decoded args a handler receives: one key per flag and per operand. */
export type HeraCliArgsOf<F extends HeraCliFlags, O extends HeraCliOperands> = {
  readonly [K in keyof F]: ValueOf<F[K]>;
} & { readonly [K in keyof O]: ValueOf<O[K]> };

/** A verb's flags and operands, declared once and shared by the verb and its handler module. */
export interface HeraCliArgsSpec<
  F extends HeraCliFlags = HeraCliFlags,
  O extends HeraCliOperands = HeraCliOperands,
> {
  readonly flags: F;
  readonly operands: O;
}

/** The decoded args of an args spec (`defineArgs`) or a verb spec. */
export type HeraCliArgs<S extends HeraCliArgsSpec<any, any>> = HeraCliArgsOf<S["flags"], S["operands"]>;

/**
 * What a verb's `load` resolves to. The runtime's handler object satisfies it; the phantom ties
 * it to the verb's args so a loader returning another verb's handler fails to compile.
 */
export interface HeraCliLoadedHandler<A> {
  readonly _tag: "HeraCliHandler";
  readonly "~args"?: ((args: A) => void) | undefined;
}

/** What an extension's `load` resolves to (its hook functions). */
export interface HeraCliLoadedExtension<A> {
  readonly _tag: "HeraCliExtensionHooks";
  readonly "~args"?: ((args: A) => void) | undefined;
}

export interface HeraCliVerbSpec<
  F extends HeraCliFlags = HeraCliFlags,
  O extends HeraCliOperands = HeraCliOperands,
> {
  readonly _tag: "HeraCliVerb";
  readonly summary: string;
  readonly flags: F;
  readonly operands: O;
  /** Accepts the global `--output json`. */
  readonly json: boolean;
  /** The usage line after `<prog> <path> `; derived from operands and flags when absent. */
  readonly usage?: string | undefined;
  /** One full command line printed under `Example:`. */
  readonly example?: string | undefined;
  /** Where the `--output json` shape is documented (help-json `output_schema`). */
  readonly outputSchema?: string | undefined;
  /** Refusal slug prefix; default the path's first word. */
  readonly slugPrefix?: string | undefined;
  readonly load: () => Promise<HeraCliLoadedHandler<HeraCliArgsOf<F, O>>>;
}

export interface HeraCliGroupSpec {
  readonly _tag: "HeraCliGroup";
  readonly summary: string;
  readonly commands: Readonly<Record<string, HeraCliCommand>>;
}

export type HeraCliCommand = HeraCliVerbSpec<any, any> | HeraCliGroupSpec;

/** Extra flags and hooks one plugin adds to another plugin's verb. */
export interface HeraCliExtensionSpec<F extends HeraCliFlags = HeraCliFlags> {
  readonly _tag: "HeraCliExtension";
  readonly flags: F;
  readonly load: () => Promise<HeraCliLoadedExtension<HeraCliArgsOf<F, {}>>>;
}

export interface HeraCliPluginSpec {
  readonly _tag: "HeraCliPlugin";
  /** Unique across a program; named in every composition error. */
  readonly name: string;
  /** Absent: every workspace gets it; else the product a workspace must have bought. */
  readonly product?: string | undefined;
  readonly commands: Readonly<Record<string, HeraCliCommand>>;
  /** Extensions keyed by the target verb's path (`"yak issue"`). */
  readonly extends?: Readonly<Record<string, HeraCliExtensionSpec<any>>> | undefined;
}

/** A typed point a base handler threads a value through (`HeraCli.hook`). */
export interface HeraCliHookPoint<T> {
  readonly _tag: "HeraCliHookPoint";
  readonly name: string;
  readonly "~value"?: ((value: T) => T) | undefined;
}

/** One flag of a composed verb, with its owner. */
export interface HeraCliResolvedFlag {
  readonly key: string;
  readonly name: `--${string}`;
  readonly spec: HeraCliFlag;
  /** `undefined` for the verb's own flag; else the extending plugin. */
  readonly extension?: string | undefined;
}

export interface HeraCliResolvedOperand {
  readonly key: string;
  readonly spec: HeraCliOperand;
}

export interface HeraCliVerbNode {
  readonly kind: "verb";
  readonly path: string;
  readonly plugin: string;
  readonly spec: HeraCliVerbSpec;
  readonly flags: readonly HeraCliResolvedFlag[];
  readonly operands: readonly HeraCliResolvedOperand[];
  readonly extensions: readonly { readonly plugin: string; readonly spec: HeraCliExtensionSpec }[];
  /** Built-in verbs (`completion`, `docs`) answer in `runPure` and have no handler. */
  readonly builtin?: "completion-bash" | "completion-zsh" | "docs" | undefined;
}

export interface HeraCliGroupNode {
  readonly kind: "group";
  readonly path: string;
  readonly summary: string;
  readonly children: readonly string[];
}

export type HeraCliNode = HeraCliVerbNode | HeraCliGroupNode;

/** A composed program: every command path (`""` is the top level) and its node. */
export interface HeraCliProgram {
  readonly _tag: "HeraCliProgram";
  readonly name: string;
  readonly summary: string;
  readonly version?: string | undefined;
  readonly nodes: ReadonlyMap<string, HeraCliNode>;
}

/** One flag of a help document (`eris-help/1`). */
export interface HeraCliHelpJsonFlag {
  readonly name: `-${string}`;
  readonly arg?: string;
  readonly summary?: string;
  readonly repeatable?: true;
  readonly alias?: string;
}

/** The help document every path prints under `--help --output json`. */
export interface HeraCliHelpJson {
  readonly schema: "eris-help/1";
  readonly path: string;
  readonly usage: string;
  readonly summary: string;
  readonly commands: readonly { readonly name: string; readonly summary: string }[];
  readonly flags: readonly HeraCliHelpJsonFlag[];
  readonly output_schema?: string;
}

/** A refusal the runtime renders as an `ErisError.usage` block (exit 2). */
export interface HeraCliRefusal {
  readonly slug: string;
  readonly what: string;
  readonly fix?: string | undefined;
}
