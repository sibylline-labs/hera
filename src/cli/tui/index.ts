/**
 * `@sibylline-labs/hera/tui`: a thin, line-based guided-step TUI (`prompt`, `select`, `confirm`) for
 * eris's guided record verb.
 *
 * - Host-agnostic: the host is reached only through `TuiIo`; `terminalIo` adapts any stdin/stdout pair.
 * - Lazy: nothing in `src/` imports this directory (`hera-tui-lazy`), so `@sibylline-labs/hera/cli`
 *   loads none of it. Consumers `await import("@sibylline-labs/hera/tui")` inside the verb that asks.
 * - Vendorable: files import only their own siblings (`hera-tui-vendorable`), so public eris copies the
 *   directory flat.
 */
import { run } from "./flow.js";
import { lineReader, scriptedIo, terminalIo } from "./io.js";
import { askStep, confirm, prompt, select } from "./steps.js";

export * from "./types.js";
export { run } from "./flow.js";
export { lineReader, scriptedIo, terminalIo, type ScriptedIo, type TuiOutput } from "./io.js";
export { askStep, confirm, prompt, select, type StepOutcome } from "./steps.js";

/** `HeraTui` namespace bundle over the `hera/tui` surface. */
export const HeraTui = {
  run,
  prompt,
  select,
  confirm,
  askStep,
  terminalIo,
  scriptedIo,
  lineReader,
} as const;
