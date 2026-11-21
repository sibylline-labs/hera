import { askStep } from "./steps.js";
import type { TuiIo, TuiResult, TuiStep } from "./types.js";

/**
 * Ask each step in order. A step whose `when` returns false is skipped and answers `undefined`.
 * End of input on any step stops the flow with `status: "cancelled"`.
 */
export async function run<const Steps extends ReadonlyArray<TuiStep>>(
  steps: Steps,
  io: TuiIo,
): Promise<TuiResult<Steps>> {
  const answers: Record<string, string | boolean | undefined> = {};
  for (const step of steps) {
    if (step.when && !step.when(answers)) {
      answers[step.key] = undefined;
      continue;
    }
    const outcome = await askStep(step, io);
    if (!outcome.ok) {
      return { status: "cancelled", at: step.key, answers } as TuiResult<Steps>;
    }
    answers[step.key] = outcome.value;
  }
  return { status: "done", answers } as TuiResult<Steps>;
}
