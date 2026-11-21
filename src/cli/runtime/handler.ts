import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { HeraAuthorityCtx } from "../../core/authority/ctx.js";
import type { ErisError } from "../errors/eris-error.js";
import type {
  HeraCliArgsOf,
  HeraCliExtensionSpec,
  HeraCliFlags,
  HeraCliLoadedExtension,
  HeraCliLoadedHandler,
  HeraCliOperands,
} from "../manifest/types.js";
import type { HeraCliAuthorityFor } from "./authority.js";
import type { HeraCliCtxShape } from "./cli-ctx.js";
import type { HeraCliHookEnv, HeraCliHookFn } from "./hooks.js";

type ArgsOfSpec<S> = S extends { readonly flags: infer F extends HeraCliFlags; readonly operands: infer O extends HeraCliOperands }
  ? HeraCliArgsOf<F, O>
  : S extends { readonly flags: infer F extends HeraCliFlags }
    ? HeraCliArgsOf<F, {}>
    : never;

/** The loaded half of a lazy verb: what its `load` thunk resolves to. */
export interface HeraCliHandler<A> extends HeraCliLoadedHandler<A> {
  readonly run: (
    args: A,
    ctx: HeraCliCtxShape,
    authority: HeraAuthorityCtx<string> | undefined,
  ) => Effect.Effect<unknown, ErisError, HeraCliHookEnv>;
  readonly layer?: Layer.Layer<any, ErisError, never> | undefined;
  readonly authority?: HeraCliAuthorityFor<A, string> | undefined;
}

type Run<A, R> = (args: A, ctx: HeraCliCtxShape) => Effect.Effect<unknown, ErisError, R | HeraCliHookEnv>;

/**
 * A lazy verb's handler, typed by the verb's args spec (`defineArgs`), so the handler module and
 * the manifest share one declaration. With `authority`, the handler runs only after the verifier
 * grants it and receives the grant; with `layer`, the handler's own services are provided.
 */
export function handler<S, R = never>(
  spec: S,
  run: Run<ArgsOfSpec<S>, R>,
  options?: { readonly layer?: Layer.Layer<R, ErisError, never> | undefined },
): HeraCliHandler<ArgsOfSpec<S>>;
export function handler<S, R, const V extends string>(
  spec: S,
  config: {
    readonly authority: HeraCliAuthorityFor<ArgsOfSpec<S>, V>;
    readonly layer?: Layer.Layer<R, ErisError, never> | undefined;
    readonly run: (
      args: ArgsOfSpec<S>,
      ctx: HeraCliCtxShape,
      authority: HeraAuthorityCtx<NoInfer<V>>,
    ) => Effect.Effect<unknown, ErisError, R | HeraCliHookEnv>;
  },
): HeraCliHandler<ArgsOfSpec<S>>;
export function handler(
  _spec: unknown,
  runOrConfig: unknown,
  options?: { readonly layer?: unknown },
): HeraCliHandler<unknown> {
  if (typeof runOrConfig === "function") {
    return { _tag: "HeraCliHandler", run: runOrConfig, layer: options?.layer } as HeraCliHandler<unknown>;
  }
  return { _tag: "HeraCliHandler", ...(runOrConfig as object) } as HeraCliHandler<unknown>;
}

/** The loaded half of an extension: its hook functions. */
export interface HeraCliExtensionHooks<A> extends HeraCliLoadedExtension<A> {
  readonly hooks: readonly HeraCliHookFn<any, A>[];
}

/** An extension's hooks (`HeraCli.on(point, fn)` each), typed by the extension's flags. */
export function extensionHooks<F extends HeraCliFlags>(
  _spec: HeraCliExtensionSpec<F> | { readonly flags: F },
  hooks: readonly HeraCliHookFn<any, HeraCliArgsOf<F, {}>>[],
): HeraCliExtensionHooks<HeraCliArgsOf<F, {}>> {
  return { _tag: "HeraCliExtensionHooks", hooks };
}
