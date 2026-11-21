import type {
  ConfirmStep,
  PromptStep,
  SelectStep,
  TuiAnswersSoFar,
  TuiIo,
  TuiOption,
  TuiStep,
} from "./types.js";

type When = { readonly when?: (answers: TuiAnswersSoFar) => boolean };

/** A free-text question. */
export const prompt = <
  const K extends string,
  const O extends When & Pick<PromptStep, "default" | "validate"> = {},
>(
  key: K,
  message: string,
  options?: O & When & Pick<PromptStep, "default" | "validate">,
): PromptStep<K> & O => ({ ...(options as O), kind: "prompt", key, message });

/** One of a fixed list of options; answered by number or by exact value. */
export const select = <
  const K extends string,
  const V extends string,
  const O extends When & { readonly default?: NoInfer<V> } = {},
>(
  key: K,
  message: string,
  options: ReadonlyArray<TuiOption<V>>,
  extra?: O & When & { readonly default?: NoInfer<V> },
): SelectStep<K, V> & O => ({ ...(extra as O), kind: "select", key, message, options });

/** A yes/no question. */
export const confirm = <const K extends string, const O extends When & { readonly default?: boolean } = {}>(
  key: K,
  message: string,
  options?: O & When & { readonly default?: boolean },
): ConfirmStep<K> & O => ({ ...(options as O), kind: "confirm", key, message });

/** One answer, or `cancelled` when input ended before a valid answer. */
export type StepOutcome<V> = { readonly ok: true; readonly value: V } | { readonly ok: false };

type Parsed<V> = { readonly value: V } | { readonly error: string };

const cancelled: StepOutcome<never> = { ok: false };

async function ask<V>(io: TuiIo, question: string, parse: (line: string) => Parsed<V>): Promise<StepOutcome<V>> {
  for (;;) {
    io.write(question);
    const line = await io.readLine();
    if (line === null) return cancelled;
    const parsed = parse(line.trim());
    if ("value" in parsed) return { ok: true, value: parsed.value };
    io.write(`  ${parsed.error}\n`);
  }
}

function askPrompt(step: PromptStep, io: TuiIo): Promise<StepOutcome<string>> {
  const hint = step.default === undefined ? "" : ` [${step.default}]`;
  return ask<string>(io, `${step.message}${hint}: `, (line) => {
    const value = line === "" ? (step.default ?? "") : line;
    if (value === "") return { error: "A value is required." };
    const error = step.validate?.(value);
    return error === undefined ? { value } : { error };
  });
}

function askSelect(step: SelectStep, io: TuiIo): Promise<StepOutcome<string>> {
  const { options } = step;
  const defaultIndex = options.findIndex((option) => option.value === step.default);
  const menu = options.map((option, i) => `  ${i + 1}) ${option.label ?? option.value}\n`).join("");
  const hint = defaultIndex === -1 ? "" : ` [${defaultIndex + 1}]`;
  io.write(`${step.message}\n${menu}`);
  return ask<string>(io, `Choose 1-${options.length}${hint}: `, (line) => {
    if (line === "" && defaultIndex !== -1) return { value: options[defaultIndex]!.value };
    const byValue = options.find((option) => option.value === line);
    if (byValue) return { value: byValue.value };
    const n = /^\d+$/.test(line) ? Number(line) : Number.NaN;
    const byNumber = options[n - 1];
    return byNumber ? { value: byNumber.value } : { error: `Enter a number from 1 to ${options.length}.` };
  });
}

const YES = new Set(["y", "yes"]);
const NO = new Set(["n", "no"]);

function askConfirm(step: ConfirmStep, io: TuiIo): Promise<StepOutcome<boolean>> {
  const hint = step.default === undefined ? "[y/n]" : step.default ? "[Y/n]" : "[y/N]";
  return ask<boolean>(io, `${step.message} ${hint}: `, (line) => {
    const answer = line.toLowerCase();
    if (answer === "" && step.default !== undefined) return { value: step.default };
    if (YES.has(answer)) return { value: true };
    if (NO.has(answer)) return { value: false };
    return { error: "Answer y or n." };
  });
}

/** Ask one step until it gets a valid answer or input ends. */
export function askStep(step: TuiStep, io: TuiIo): Promise<StepOutcome<string | boolean>> {
  switch (step.kind) {
    case "prompt":
      return askPrompt(step, io);
    case "select":
      return askSelect(step, io);
    case "confirm":
      return askConfirm(step, io);
  }
}
