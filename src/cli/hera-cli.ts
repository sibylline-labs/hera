import {
  ErisError,
  ErisErrorClass,
  failureLines,
  renderFailureBlock,
  resolveErisHome,
  scrubFreeText,
} from "./errors/index.js";
import {
  AtomicPairWriter,
  DirLock,
  acquireDirLockSync,
  isPidAlive,
  releaseDirLockSync,
  stagePair,
  withDirLock,
  writeFileAtomic,
  writePair,
  writePairEffect,
} from "./fs/index.js";
import {
  Runner,
  buildChildEnv,
  defaultRunner,
  psSnapshot,
  signalTree,
  subtree,
} from "./process/index.js";
import {
  type DefineVerbConfig,
  composeProgram,
  defineArgs,
  defineExtension,
  defineGroup,
  definePlugin,
  defineVerb,
  flag,
  hookPoint,
  operand,
} from "./manifest/index.js";
import type { HeraCliFlags, HeraCliOperands, HeraCliVerbSpec } from "./manifest/types.js";
import type * as Schema from "effect/Schema";
import {
  type HeraCliAuthorizedVerbConfig,
  HeraCliCtx,
  type HeraCliVerb,
  type HeraCliVerbConfig,
  extensionHooks,
  forEachBounded,
  handler,
  hook,
  on,
  program,
  resolveConcurrency,
  resolveDeadlineMs,
  verb as eagerVerb,
} from "./runtime/index.js";

/**
 * `HeraCli.verb`: with `load`, declares a lazy verb for a manifest (`defineVerb`); with `handler`,
 * builds the eager callable verb (`HeraCli.verb({ name, args, handler })`), unchanged.
 */
function verb<const F extends HeraCliFlags = {}, const O extends HeraCliOperands = {}>(
  config: DefineVerbConfig<F, O>,
): HeraCliVerbSpec<F, O>;
function verb<S extends Schema.Top | undefined = undefined, A = void, R = never>(
  config: HeraCliVerbConfig<S, A, R>,
): HeraCliVerb<S, A>;
function verb<S extends Schema.Top | undefined, A, R, const V extends string>(
  config: HeraCliAuthorizedVerbConfig<S, A, R, V>,
): HeraCliVerb<S, A>;
function verb(config: unknown): unknown {
  if (typeof config === "object" && config !== null && "load" in config) {
    return defineVerb(config as DefineVerbConfig<HeraCliFlags, HeraCliOperands>);
  }
  return eagerVerb(config as Parameters<typeof eagerVerb>[0]);
}

/**
 * `HeraCli` namespace bundle exposing the complete CLI host adapter surface.
 */
export const HeraCli = {
  verb,
  args: defineArgs,
  flag,
  operand,
  group: defineGroup,
  plugin: definePlugin,
  extension: defineExtension,
  hookPoint,
  compose: composeProgram,
  program,
  handler,
  extensionHooks,
  on,
  hook,
  HeraCliCtx,
  ErisError,
  ErisErrorClass,
  renderFailureBlock,
  failureLines,
  scrubFreeText,
  resolveErisHome,
  Runner,
  defaultRunner,
  psSnapshot,
  subtree,
  signalTree,
  isPidAlive,
  buildChildEnv,
  AtomicPairWriter,
  stagePair,
  writePair,
  writePairEffect,
  writeFileAtomic,
  DirLock,
  acquireDirLockSync,
  releaseDirLockSync,
  withDirLock,
  forEachBounded,
  resolveConcurrency,
  resolveDeadlineMs,
} as const;
