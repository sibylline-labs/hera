import type {
  HeraCliArgsOf,
  HeraCliArgsSpec,
  HeraCliCommand,
  HeraCliExtensionSpec,
  HeraCliFlags,
  HeraCliGroupSpec,
  HeraCliHookPoint,
  HeraCliLoadedExtension,
  HeraCliLoadedHandler,
  HeraCliOperands,
  HeraCliPluginSpec,
  HeraCliVerbSpec,
} from "./types.js";

/**
 * A verb's flags and operands as one value. The verb spreads it (`...issueArgs`) and the handler
 * module types against it, so neither restates the other and no type cycle forms through `load`.
 */
export function defineArgs<
  const F extends HeraCliFlags = {},
  const O extends HeraCliOperands = {},
>(config: { readonly flags?: F | undefined; readonly operands?: O | undefined }): HeraCliArgsSpec<F, O> {
  return { flags: config.flags ?? ({} as F), operands: config.operands ?? ({} as O) };
}

export interface DefineVerbConfig<F extends HeraCliFlags, O extends HeraCliOperands> {
  readonly summary: string;
  readonly flags?: F | undefined;
  readonly operands?: O | undefined;
  readonly json?: boolean | undefined;
  readonly usage?: string | undefined;
  readonly example?: string | undefined;
  readonly outputSchema?: string | undefined;
  readonly slugPrefix?: string | undefined;
  /** The handler, behind a thunk: `() => import("./x.js").then((m) => m.handler)`. */
  readonly load: () => Promise<HeraCliLoadedHandler<NoInfer<HeraCliArgsOf<F, O>>>>;
}

/**
 * Declares a verb once: its flags, operands and help text are data, and its handler is a lazy
 * thunk called only on dispatch, so help and completion never load handler code.
 */
export function defineVerb<
  const F extends HeraCliFlags = {},
  const O extends HeraCliOperands = {},
>(config: DefineVerbConfig<F, O>): HeraCliVerbSpec<F, O> {
  return {
    _tag: "HeraCliVerb",
    summary: config.summary,
    flags: config.flags ?? ({} as F),
    operands: config.operands ?? ({} as O),
    json: config.json === true,
    usage: config.usage,
    example: config.example,
    outputSchema: config.outputSchema,
    slugPrefix: config.slugPrefix,
    load: config.load,
  };
}

/** A group of commands (verbs or nested groups) under one word. */
export function defineGroup<const C extends Readonly<Record<string, HeraCliCommand>>>(config: {
  readonly summary: string;
  readonly commands: C;
}): HeraCliGroupSpec & { readonly commands: C } {
  return { _tag: "HeraCliGroup", summary: config.summary, commands: config.commands };
}

/**
 * Extra flags (and the hooks that read them) one plugin adds to another plugin's verb. The flags
 * join the target's help, help-json and completion at composition; the hooks load on dispatch.
 */
export function defineExtension<const F extends HeraCliFlags>(config: {
  readonly flags: F;
  readonly load: () => Promise<HeraCliLoadedExtension<NoInfer<HeraCliArgsOf<F, {}>>>>;
}): HeraCliExtensionSpec<F> {
  return { _tag: "HeraCliExtension", flags: config.flags, load: config.load };
}

/** A plugin: top-level commands, plus extensions of other plugins' verbs keyed by path. */
export function definePlugin(config: {
  readonly name: string;
  readonly product?: string | undefined;
  readonly commands: Readonly<Record<string, HeraCliCommand>>;
  readonly extends?: Readonly<Record<string, HeraCliExtensionSpec<any>>> | undefined;
}): HeraCliPluginSpec {
  return {
    _tag: "HeraCliPlugin",
    name: config.name,
    product: config.product,
    commands: config.commands,
    extends: config.extends,
  };
}

/** A typed point a base handler threads a value through; extensions register on it by name. */
export function hookPoint<T>(name: string): HeraCliHookPoint<T> {
  return { _tag: "HeraCliHookPoint", name };
}
