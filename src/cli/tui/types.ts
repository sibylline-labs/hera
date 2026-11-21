/**
 * Step and IO types for `@sibylline-labs/hera/tui`.
 *
 * Vendorable: this directory imports only its own siblings (`hera-tui-vendorable`), so public eris
 * copies it flat.
 */

/** The only way the TUI reaches a host: write text, read one line (`null` at end of input). */
export interface TuiIo {
  readonly write: (text: string) => void;
  readonly readLine: () => Promise<string | null>;
}

/** Answers gathered so far, as `when` predicates see them. */
export type TuiAnswersSoFar = Readonly<Record<string, string | boolean | undefined>>;

interface TuiStepBase<K extends string> {
  readonly key: K;
  readonly message: string;
  /** Skip the step (its answer is `undefined`) unless this returns true. */
  readonly when?: (answers: TuiAnswersSoFar) => boolean;
}

export interface PromptStep<K extends string = string> extends TuiStepBase<K> {
  readonly kind: "prompt";
  readonly default?: string;
  /** Return an error message to re-ask, or `undefined` to accept. */
  readonly validate?: (value: string) => string | undefined;
}

export interface TuiOption<V extends string = string> {
  readonly value: V;
  readonly label?: string;
}

export interface SelectStep<K extends string = string, V extends string = string>
  extends TuiStepBase<K> {
  readonly kind: "select";
  readonly options: ReadonlyArray<TuiOption<V>>;
  readonly default?: V;
}

export interface ConfirmStep<K extends string = string> extends TuiStepBase<K> {
  readonly kind: "confirm";
  readonly default?: boolean;
}

export type TuiStep = PromptStep | SelectStep | ConfirmStep;

/** The value one step yields: `prompt` → `string`, `select` → its option values, `confirm` → `boolean`. */
export type TuiStepValue<S> = S extends { readonly kind: "prompt" }
  ? string
  : S extends SelectStep<string, infer V>
    ? V
    : S extends { readonly kind: "confirm" }
      ? boolean
      : never;

type TuiAnswerOf<S> = S extends { readonly when: (answers: TuiAnswersSoFar) => boolean }
  ? TuiStepValue<S> | undefined
  : TuiStepValue<S>;

/** The answers object for a step list, keyed by each step's `key`. */
export type TuiAnswers<Steps extends ReadonlyArray<TuiStep>> = {
  readonly [S in Steps[number] as S["key"]]: TuiAnswerOf<S>;
};

export type TuiResult<Steps extends ReadonlyArray<TuiStep>> =
  | { readonly status: "done"; readonly answers: TuiAnswers<Steps> }
  | {
      readonly status: "cancelled";
      /** The step that hit end of input. */
      readonly at: Steps[number]["key"];
      readonly answers: Partial<TuiAnswers<Steps>>;
    };
