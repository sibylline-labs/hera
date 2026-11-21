import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type { HeraAuthorityCtx } from "../../core/authority/ctx.js";
import type { HeraLoggerService } from "../../core/logger/index.js";
import { ErrorSlug, decodeResult } from "../../core/schema/index.js";
import { ErisError, type ErisExitCode } from "../errors/eris-error.js";
import { renderFailureBlock } from "../errors/failure-block.js";
import { deriveUsageSlug, summarizeSchemaIssues } from "./usage.js";
import { Runner } from "../process/runner.js";
import { type HeraCliAuthority, authorize } from "./authority.js";
import {
  HeraCliCtx,
  type HeraCliCtxInput,
  type HeraCliCtxShape,
  type HeraCliDocs,
  makeHeraCliCtxShape,
  mergeCliCtxShape,
} from "./cli-ctx.js";

export {
  HeraCliCtx,
  type HeraCliCtxInput,
  type HeraCliCtxShape,
  type HeraCliDocs,
  makeHeraCliCtxShape,
} from "./cli-ctx.js";

type DecodedArgs<S extends Schema.Top | undefined> = S extends Schema.Top
  ? S["Type"]
  : undefined;

type HandlerEffect<A, R> = Effect.Effect<
  A,
  ErisError,
  R | HeraCliCtx | Runner | HeraLoggerService
>;

export interface HeraCliVerbConfig<
  S extends Schema.Top | undefined = undefined,
  A = void,
  R = never,
> {
  readonly name: string;
  readonly args?: S | undefined;
  readonly slug?: ErrorSlug | string | undefined;
  readonly layer?: Layer.Layer<R, ErisError, never> | undefined;
  /** Default error-docs location for failures this verb renders. */
  readonly docs?: HeraCliDocs | undefined;
  /** Absent: the handler takes no authority ctx. See `HeraCliAuthorizedVerbConfig`. */
  readonly authority?: undefined;
  readonly handler: (args: DecodedArgs<S>, ctx: HeraCliCtxShape) => HandlerEffect<A, R>;
}

/**
 * A verb guarded by an authority check: the handler runs only after `authority.verifier` grants
 * `authority.verb`, and receives the grant as `HeraAuthorityCtx<V>`.
 */
export interface HeraCliAuthorizedVerbConfig<
  S extends Schema.Top | undefined,
  A,
  R,
  V extends string,
> {
  readonly name: string;
  readonly args?: S | undefined;
  readonly slug?: ErrorSlug | string | undefined;
  readonly layer?: Layer.Layer<R, ErisError, never> | undefined;
  /** Default error-docs location for failures this verb renders. */
  readonly docs?: HeraCliDocs | undefined;
  readonly authority: HeraCliAuthority<S, V>;
  readonly handler: (
    args: DecodedArgs<S>,
    ctx: HeraCliCtxShape,
    authority: HeraAuthorityCtx<NoInfer<V>>,
  ) => HandlerEffect<A, R>;
}

export interface HeraCliVerb<
  S extends Schema.Top | undefined = undefined,
  A = void,
> {
  (
    rawArgs?: unknown,
    ctxOverrides?: HeraCliCtxInput,
  ): Promise<0 | ErisExitCode>;
  readonly name: string;
  readonly argsSchema: S | undefined;
  readonly run: (
    rawArgs?: unknown,
    ctxOverrides?: HeraCliCtxInput,
  ) => Promise<0 | ErisExitCode>;
  readonly effect: (
    rawArgs?: unknown,
    ctxOverrides?: HeraCliCtxInput,
  ) => Effect.Effect<A, ErisError, HeraCliCtx | Runner | HeraLoggerService>;
}

/**
 * Defines a typed CLI verb:
 * 1. Decodes CLI args via `HeraSchema` (`decodeResult`), mapping validation failures to
 *    `ErisError.usage` (`exitCode: 2`) with value-stripped diagnostics.
 * 2. With `authority`, asks the verifier before the handler; a refusal exits 3 with the
 *    verifier's code as the slug, and the handler never runs.
 * 3. Provides `HeraCliCtx` and `Runner.live`.
 * 4. Runs `handler` under `Effect.runPromiseExit` and maps `Exit` to deterministic exit codes.
 */
export function verb<
  S extends Schema.Top | undefined = undefined,
  A = void,
  R = never,
>(config: HeraCliVerbConfig<S, A, R>): HeraCliVerb<S, A>;
export function verb<
  S extends Schema.Top | undefined,
  A,
  R,
  const V extends string,
>(config: HeraCliAuthorizedVerbConfig<S, A, R, V>): HeraCliVerb<S, A>;
export function verb<
  S extends Schema.Top | undefined,
  A,
  R,
  V extends string,
>(
  config: HeraCliVerbConfig<S, A, R> | HeraCliAuthorizedVerbConfig<S, A, R, V>,
): HeraCliVerb<S, A> {
  const buildEffect = (
    rawArgs?: unknown,
    ctxOverrides?: HeraCliCtxInput,
  ): Effect.Effect<A, ErisError, HeraCliCtx | Runner | HeraLoggerService> =>
    Effect.flatMap(Effect.service(HeraCliCtx), (ambientCtx) => {
      const effectiveCtx = mergeCliCtxShape(ambientCtx, ctxOverrides);
      let decodedArgs: DecodedArgs<S>;
      if (config.args !== undefined) {
        const decoded = decodeResult(config.args, rawArgs);
        if (decoded._tag === "Failure") {
          const usageSlug = deriveUsageSlug(config.name, config.slug);
          const summary = summarizeSchemaIssues(decoded.failure.issues);
          return Effect.fail(
            ErisError.usage(usageSlug, {
              what: `${config.name}: invalid arguments — ${summary}`,
              fix: `Check the arguments for '${config.name}' and run again.`,
              cause: decoded.failure,
            }),
          );
        }
        decodedArgs = decoded.success as DecodedArgs<S>;
      } else {
        decodedArgs = undefined as DecodedArgs<S>;
      }

      const handlerEffect: HandlerEffect<A, R> =
        config.authority === undefined
          ? config.handler(decodedArgs, effectiveCtx)
          : Effect.flatMap(
              authorize(config.name, config.authority, decodedArgs, effectiveCtx),
              (granted) => config.handler(decodedArgs, effectiveCtx, granted),
            );
      return config.layer !== undefined
        ? Effect.provide(handlerEffect, config.layer)
        : (handlerEffect as Effect.Effect<
            A,
            ErisError,
            HeraCliCtx | Runner | HeraLoggerService
          >);
    });

  const runVerb = async (
    rawArgs?: unknown,
    ctxOverrides?: HeraCliCtxInput,
  ): Promise<0 | ErisExitCode> => {
    const ctxShape = makeHeraCliCtxShape({
      service: config.name,
      ...ctxOverrides,
      docsBase: ctxOverrides?.docsBase ?? config.docs?.base,
      docsPath: ctxOverrides?.docsPath ?? config.docs?.path,
    });
    const baseLayer = Layer.mergeAll(
      Layer.succeed(HeraCliCtx, ctxShape),
      ctxShape.logger.layer,
      Runner.live,
    );

    const exit = await Effect.runPromiseExit(
      Effect.provide(buildEffect(rawArgs, ctxOverrides), baseLayer),
    );
    if (Exit.isSuccess(exit)) return 0;

    const errOpt = Cause.findErrorOption(exit.cause);
    const renderOpts = {
      erisHome: ctxShape.erisHome,
      docsBase: ctxShape.docsBase,
      docsPath: ctxShape.docsPath,
      env: ctxShape.env,
    };
    if (Option.isSome(errOpt) && ErisError.is(errOpt.value)) {
      ctxShape.stderr(renderFailureBlock(errOpt.value, renderOpts));
      return errOpt.value.exitCode;
    }

    const internalErr = ErisError.operational(
      ErrorSlug.make("cli-internal-error"),
      { what: `${config.name}: unexpected internal failure` },
    );
    ctxShape.stderr(renderFailureBlock(internalErr, renderOpts));
    return 1;
  };

  const callable = ((
    rawArgs?: unknown,
    ctxOverrides?: HeraCliCtxInput,
  ): Promise<0 | ErisExitCode> => runVerb(rawArgs, ctxOverrides)) as HeraCliVerb<
    S,
    A
  >;

  Object.defineProperty(callable, "name", {
    value: config.name,
    writable: false,
    configurable: true,
  });

  return Object.assign(callable, {
    argsSchema: config.args,
    run: runVerb,
    effect: buildEffect,
  });
}
