import * as Effect from "effect/Effect";
import { ErisError, type ErisExitCode } from "../errors/eris-error.js";
import { renderFailureBlock } from "../errors/failure-block.js";
import { runPure } from "../manifest/run-pure.js";
import { slugPrefixOf } from "../manifest/tokenize.js";
import type { HeraCliProgram, HeraCliRefusal, HeraCliVerbNode } from "../manifest/types.js";
import { argsSchemaOf, extensionKeysOf, ownKeysOf, pick } from "./args-schema.js";
import { type HeraCliCtxInput, type HeraCliCtxShape, type HeraCliDocs, makeHeraCliCtxShape } from "./cli-ctx.js";
import type { HeraCliExtensionHooks, HeraCliHandler } from "./handler.js";
import { type HeraCliBoundExtension, HeraCliHooks, makeHooks } from "./hooks.js";
import { verb } from "./verb.js";

export interface HeraCliProgramOptions {
  /** Default error-docs location for every failure the program renders. */
  readonly docs?: HeraCliDocs | undefined;
}

/** A composed manifest bound to the runtime: `run(argv)` resolves to the exit code. */
export interface HeraCliProgramRunner {
  readonly manifest: HeraCliProgram;
  readonly run: (argv: readonly string[], ctx?: HeraCliCtxInput) => Promise<0 | ErisExitCode>;
}

function render(shape: HeraCliCtxShape, err: ErisError): void {
  shape.stderr(
    renderFailureBlock(err, { erisHome: shape.erisHome, docsBase: shape.docsBase, docsPath: shape.docsPath, env: shape.env }),
  );
}

function refusalError(refusal: HeraCliRefusal): ErisError {
  return ErisError.usage(refusal.slug, { what: refusal.what, ...(refusal.fix !== undefined ? { fix: refusal.fix } : {}) });
}

function loadFailure(manifest: HeraCliProgram, node: HeraCliVerbNode, what: string): ErisError {
  return ErisError.operational("cli-handler-load-failed", {
    what: `${manifest.name} ${node.path}: ${what}`,
    fix: "Reinstall the binary; a build whose handler module is missing or malformed cannot run this command.",
  });
}

async function loadAll(
  node: HeraCliVerbNode,
): Promise<{ readonly impl: HeraCliHandler<unknown>; readonly exts: readonly { readonly plugin: string; readonly loaded: HeraCliExtensionHooks<unknown> }[] } | string> {
  const impl = (await node.spec.load()) as HeraCliHandler<unknown> | undefined;
  if (impl?._tag !== "HeraCliHandler" || typeof impl.run !== "function") return "its load thunk did not resolve to a HeraCli.handler";
  const exts = await Promise.all(
    node.extensions.map(async (e) => ({ plugin: e.plugin, loaded: (await e.spec.load()) as HeraCliExtensionHooks<unknown> })),
  );
  const bad = exts.find((e) => e.loaded?._tag !== "HeraCliExtensionHooks");
  return bad === undefined ? { impl, exts } : `extension ${bad.plugin} did not resolve to HeraCli.extensionHooks`;
}

/**
 * Runs one command line against a composed manifest: `runPure` answers help, help-json,
 * `--version`, `completion` and `docs`; a malformed line exits 2 with its slugged block; a plugin
 * verb loads its handler (and its extensions' hooks), decodes the line against the schema its
 * flags derive, and runs under `HeraCli.verb` (authority, layer, failure block, exit code).
 */
export async function runProgram(
  manifest: HeraCliProgram,
  argv: readonly string[],
  ctxInput: HeraCliCtxInput = {},
  options: HeraCliProgramOptions = {},
): Promise<0 | ErisExitCode> {
  const input: HeraCliCtxInput = {
    service: manifest.name,
    ...ctxInput,
    docsBase: ctxInput.docsBase ?? options.docs?.base,
    docsPath: ctxInput.docsPath ?? options.docs?.path,
  };
  const shape = makeHeraCliCtxShape(input);
  const outcome = runPure(manifest, argv, { stdout: shape.stdout, env: shape.env });
  if (outcome._tag === "Done") return 0;
  if (outcome._tag === "Refuse") {
    render(shape, refusalError(outcome.refusal));
    return 2;
  }
  const { node } = outcome;
  let loaded: Awaited<ReturnType<typeof loadAll>>;
  try {
    loaded = await loadAll(node);
  } catch {
    loaded = "its handler module failed to load";
  }
  if (typeof loaded === "string") {
    render(shape, loadFailure(manifest, node, loaded));
    return 1;
  }
  const { impl, exts } = loaded;
  const own = ownKeysOf(node);
  const run = (args: Readonly<Record<string, unknown>>, ctx: HeraCliCtxShape, authority?: unknown) => {
    const bound: HeraCliBoundExtension[] = exts.map((e) => ({
      hooks: e.loaded.hooks,
      args: pick(args, extensionKeysOf(node, e.plugin)),
    }));
    const effect = impl.run(pick(args, own), ctx, authority as Parameters<typeof impl.run>[2]);
    return Effect.provideService(effect, HeraCliHooks, makeHooks(bound, ctx));
  };
  const cliVerb = verb({
    name: `${manifest.name} ${node.path}`,
    slug: `${slugPrefixOf(node)}-invalid-args`,
    args: argsSchemaOf(node),
    docs: options.docs,
    layer: impl.layer,
    ...(impl.authority !== undefined ? { authority: impl.authority } : {}),
    handler: run,
  } as Parameters<typeof verb>[0]);
  return cliVerb.run(outcome.raw, { ...input, isJson: outcome.mode === "json" });
}

/** Binds a composed manifest to the runtime. */
export function program(manifest: HeraCliProgram, options: HeraCliProgramOptions = {}): HeraCliProgramRunner {
  return { manifest, run: (argv, ctx) => runProgram(manifest, argv, ctx, options) };
}
