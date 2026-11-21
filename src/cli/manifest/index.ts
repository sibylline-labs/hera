/**
 * `@sibylline-labs/hera/cli/manifest`: the pure half of the CLI host. A verb is declared once
 * here; routing, argv tokenizing, help, `eris-help/1` help-json, docs and bash/zsh completion
 * derive from that declaration. This sub-plane imports only its siblings (no `effect`, no other
 * plane), so a binary answers `--help` and `completion` without loading a handler.
 */
export {
  type HeraCliArgs,
  type HeraCliArgsOf,
  type HeraCliArgsSpec,
  type HeraCliCommand,
  type HeraCliCompleteWord,
  type HeraCliCompletionDomain,
  type HeraCliExtensionSpec,
  type HeraCliFlag,
  type HeraCliFlagKind,
  type HeraCliFlags,
  type HeraCliGroupNode,
  type HeraCliGroupSpec,
  type HeraCliHelpJson,
  type HeraCliHelpJsonFlag,
  type HeraCliHookPoint,
  type HeraCliLoadedExtension,
  type HeraCliLoadedHandler,
  type HeraCliNode,
  type HeraCliOperand,
  type HeraCliOperandKind,
  type HeraCliOperands,
  type HeraCliPluginSpec,
  type HeraCliProgram,
  type HeraCliRefusal,
  type HeraCliResolvedFlag,
  type HeraCliResolvedOperand,
  type HeraCliVerbNode,
  type HeraCliVerbSpec,
} from "./types.js";
export { flag, flagNameOf, operand, type NumberFlagOptions, type StringFlagOptions } from "./flag.js";
export {
  type DefineVerbConfig,
  defineArgs,
  defineExtension,
  defineGroup,
  definePlugin,
  defineVerb,
  hookPoint,
} from "./define.js";
export { type ComposeProgramConfig, HeraCliManifestError, composeProgram } from "./compose.js";
export { asksForHelp, type HeraCliTokens, slugPrefixOf, tokenize } from "./tokenize.js";
export { type HeraCliGlobals, type HeraCliOutputMode, type HeraCliRoute, parseGlobals, route } from "./route.js";
export { allPaths, docsJson, docsText, helpJson, helpText, usageLine } from "./help.js";
export { completionScript, type HeraCliShell } from "./completion.js";
export { type HeraCliPureIo, type HeraCliPureOutcome, runPure } from "./run-pure.js";
