import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type HeraLogger,
  type HeraLoggerService,
  createHeraLogger,
} from "../../core/logger/index.js";
import {
  DEFAULT_ERIS_DOCS_BASE,
  DEFAULT_ERROR_DOCS_PATH,
  resolveErisHome,
} from "../errors/failure-block.js";

export interface HeraCliCtxShape {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly isJson: boolean;
  readonly clock: Clock.Clock;
  readonly logger: HeraLogger;
  readonly erisHome: string;
  readonly docsBase: string;
  readonly docsPath: string;
}

/** A verb's default error-docs location; a per-run `HeraCliCtxInput` value wins. */
export interface HeraCliDocs {
  /** Docs site base URL (default `DEFAULT_ERIS_DOCS_BASE`). */
  readonly base?: string | undefined;
  /** Repo-relative error catalog file (default `docs/ERRORS.md`). */
  readonly path?: string | undefined;
}

export interface HeraCliCtxInput {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stdout?: ((text: string) => void) | undefined;
  readonly stderr?: ((text: string) => void) | undefined;
  readonly isJson?: boolean | undefined;
  readonly clock?: Clock.Clock | undefined;
  readonly logger?: HeraLogger | undefined;
  readonly erisHome?: string | undefined;
  readonly docsBase?: string | undefined;
  readonly docsPath?: string | undefined;
  readonly service?: string | undefined;
}

export function makeHeraCliCtxShape(
  input: HeraCliCtxInput = {},
): HeraCliCtxShape {
  const env = input.env ?? process.env;
  return {
    cwd: input.cwd ?? process.cwd(),
    env,
    stdout: input.stdout ?? ((text: string) => void process.stdout.write(text)),
    stderr: input.stderr ?? ((text: string) => void process.stderr.write(text)),
    isJson: input.isJson ?? false,
    clock: input.clock ?? Clock.Clock.defaultValue(),
    logger:
      input.logger ?? createHeraLogger({ service: input.service ?? "eris-cli" }),
    erisHome: resolveErisHome({ erisHome: input.erisHome, env }),
    docsBase: input.docsBase ?? DEFAULT_ERIS_DOCS_BASE,
    docsPath: input.docsPath ?? DEFAULT_ERROR_DOCS_PATH,
  };
}

export function mergeCliCtxShape(
  base: HeraCliCtxShape,
  overrides: HeraCliCtxInput | undefined,
): HeraCliCtxShape {
  if (overrides === undefined) return base;
  return makeHeraCliCtxShape({
    cwd: overrides.cwd ?? base.cwd,
    env: overrides.env ?? base.env,
    stdout: overrides.stdout ?? base.stdout,
    stderr: overrides.stderr ?? base.stderr,
    isJson: overrides.isJson ?? base.isJson,
    clock: overrides.clock ?? base.clock,
    logger: overrides.logger ?? base.logger,
    erisHome: overrides.erisHome ?? base.erisHome,
    docsBase: overrides.docsBase ?? base.docsBase,
    docsPath: overrides.docsPath ?? base.docsPath,
  });
}

/**
 * Ambient context for `HeraCli.verb` handlers.
 */
export class HeraCliCtx extends Context.Service<HeraCliCtx, HeraCliCtxShape>()(
  "@sibylline-labs/hera/HeraCliCtx",
) {
  static layer(
    input: HeraCliCtxInput = {},
  ): Layer.Layer<HeraCliCtx | HeraLoggerService> {
    const shape = makeHeraCliCtxShape(input);
    return Layer.mergeAll(
      Layer.succeed(HeraCliCtx, shape),
      shape.logger.layer,
    );
  }

  static get live(): Layer.Layer<HeraCliCtx | HeraLoggerService> {
    return HeraCliCtx.layer();
  }

  static get current(): Effect.Effect<HeraCliCtxShape, never, HeraCliCtx> {
    return Effect.service(HeraCliCtx);
  }
}
