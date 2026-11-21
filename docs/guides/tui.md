# Guided Step TUI (`HeraTui`, `@sibylline-labs/hera/tui`)

`@sibylline-labs/hera/tui` (`src/cli/tui/`) is a thin, line-based guided TUI: `prompt`, `select` and `confirm` steps run in order by `HeraTui.run`. It exists for eris's guided record verb, which opens it when attached to a terminal; agents drive the same flow with flags and `--json` instead.

It has three properties, each held by a check:

| Property | What it means | Held by |
|---|---|---|
| Host-agnostic | The engine reaches the host only through `TuiIo` (`write`, `readLine`). It imports no `effect`, no `node:*` and no other Hera plane, and typechecks with no ambient types. | `rules/ast-grep/hera-tui-vendorable.yml`, the `test/consumers/pure` fixture |
| Lazy | No `src/` module outside `src/cli/tui/` imports it, so `@sibylline-labs/hera/cli` loads none of it. Import the subpath with `await import(...)` inside the verb that asks. | `rules/ast-grep/hera-tui-lazy.yml`, `test/tui-cold-start.test.ts` (<50ms) |
| Vendorable | Every file imports only its own siblings, so public eris copies the directory flat, as eris#10 did for the CLI primitives. | `rules/ast-grep/hera-tui-vendorable.yml` |

---

## 1. Defining and running a flow

Answers are typed from the step list: `prompt` gives a `string`, `confirm` a `boolean`, and `select` the union of its option values. A step with `when` can be skipped, so its answer is `| undefined`. Invalid input re-asks with a one-line reason. End of input cancels the flow at the step that was asking.

```ts
import { HeraTui, type TuiIo } from "@sibylline-labs/hera/tui";

const steps = [
  HeraTui.prompt("title", "Title", {
    validate: (value: string) => (value.length < 3 ? "At least 3 characters." : undefined),
  }),
  HeraTui.select(
    "kind",
    "Entry kind",
    [
      { value: "lbd", label: "Load-bearing decision" },
      { value: "practice", label: "Practice" },
    ],
    { default: "lbd" },
  ),
  HeraTui.prompt("practiceDoc", "Practices doc", {
    when: (answers) => answers["kind"] === "practice",
  }),
  HeraTui.confirm("submit", "Submit now?", { default: true }),
] as const;

export async function askRecord(io: TuiIo) {
  const result = await HeraTui.run(steps, io);
  if (result.status === "cancelled") return undefined;
  const kind: "lbd" | "practice" = result.answers.kind;
  return { ...result.answers, kind };
}
```

The terminal renders one question per line:

```text
Title: Ship it
Entry kind
  1) Load-bearing decision
  2) Practice
Choose 1-2 [1]: 2
Practices doc: Practices — hera
Submit now? [Y/n]: y
```

## 2. Lazy loading from a CLI verb

Keep the import inside the branch that needs it, so a run that never asks (completion, `--help`, `--json`) pays nothing.

```ts
export async function recordInteractively() {
  const { HeraTui } = await import("@sibylline-labs/hera/tui");
  const io = HeraTui.terminalIo({ input: process.stdin, output: process.stdout });
  return HeraTui.run([HeraTui.confirm("submit", "Submit now?", { default: true })] as const, io);
}
```

`terminalIo` takes any `AsyncIterable<Uint8Array | string>` and any `{ write(text) }`, so it fits Bun and Node `process.stdin`/`process.stdout` without importing either. `lineReader` splits chunks that are not line-aligned, accepts `\r\n`, and returns a final line that has no newline.

## 3. Driving a flow headlessly

`HeraTui.scriptedIo(lines)` feeds each `readLine` the next scripted line, then `null`. `transcript()` returns everything written, with each consumed answer echoed after its question, and `remaining()` counts unread lines.

```ts
import { HeraTui } from "@sibylline-labs/hera/tui";

export async function headless() {
  const scripted = HeraTui.scriptedIo(["Ship it", "y"]);
  const result = await HeraTui.run(
    [HeraTui.prompt("title", "Title"), HeraTui.confirm("submit", "Submit now?")] as const,
    scripted.io,
  );
  // result: { status: "done", answers: { title: "Ship it", submit: true } }
  return { result, transcript: scripted.transcript() };
}
```

## 4. Vendoring into public eris

Copy `src/cli/tui/*.ts` into public eris as-is. The files need no rewrite, because they import only each other with `./x.js` specifiers. Public eris then keeps its own lazy check: importing the eris CLI entry without calling `record` loads no TUI module.
