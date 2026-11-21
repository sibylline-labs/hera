import { execFileSync } from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ErrorSlug } from "../../core/schema/index.js";
import { ErisError } from "../errors/eris-error.js";
import { executeChildProcess } from "./spawn.js";
import type { RunResult, RunSpec, RunnerShape } from "./types.js";

/**
 * Snapshots `(pid, ppid)` pairs from `ps -Ao pid=,ppid=` so `signalTree` can signal
 * an entire descendant subtree even when children did not call `setpgid`.
 */
export function psSnapshot(): Map<number, number[]> {
  const byParent = new Map<number, number[]>();
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number.parseInt(parts[0] ?? "", 10);
      const ppid = Number.parseInt(parts[1] ?? "", 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      let list = byParent.get(ppid);
      if (!list) {
        list = [];
        byParent.set(ppid, list);
      }
      list.push(pid);
    }
  } catch {
    // ps unavailable or timed out; caller still signals root pid
  }
  return byParent;
}

/**
 * Returns all PIDs in `rootPid`'s process subtree in bottom-up order (leaves first,
 * `rootPid` last) so children receive signals before their parents can reparent them.
 */
export function subtree(
  rootPid: number,
  byParent: Map<number, number[]>,
): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (pid: number): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const children = byParent.get(pid) ?? [];
    for (const childPid of children) {
      visit(childPid);
    }
    order.push(pid);
  };
  visit(rootPid);
  return order;
}

/**
 * Signals `rootPid` and all descendants (plus any previously discovered `extraPids`
 * that may have been reparented to PID 1 after their parent exited).
 *
 * Returns the set of all PIDs signaled so escalation can re-target any survivors.
 */
export function signalTree(
  rootPid: number,
  sig: NodeJS.Signals,
  extraPids?: Iterable<number>,
): number[] {
  const targets = subtree(rootPid, psSnapshot());
  const seen = new Set<number>(targets);
  if (extraPids) {
    for (const pid of extraPids) {
      if (!seen.has(pid)) {
        seen.add(pid);
        // Signal extra (potentially reparented) descendants before rootPid
        targets.unshift(pid);
      }
    }
  }
  for (const pid of targets) {
    try {
      process.kill(pid, sig);
    } catch {
      // ESRCH / EPERM — already exited
    }
  }
  return Array.from(seen);
}

/**
 * Default live `RunnerShape` implementation using `node:child_process` with
 * descendant tree kill (`psSnapshot` + `signalTree`), `BUN_CONFIG_VERBOSE_FETCH`
 * stripping, `_ERIS_SHIM_IGNORED="1"`, `forcedClose` pipe destruction after `SIGKILL`,
 * and fiber interruption cleanup.
 */
export const defaultRunner: RunnerShape = {
  run: (spec: RunSpec) =>
    Effect.callback<RunResult, ErisError>((resume) => {
      const handle = executeChildProcess(spec);
      handle.promise.then(
        (result) => {
          resume(Effect.succeed(result));
        },
        (err) => {
          resume(
            Effect.fail(
              ErisError.operational(ErrorSlug.make("runner-spawn-failed"), {
                what:
                  err instanceof Error
                    ? err.message
                    : "Subprocess execution failed",
                cause: err,
              }),
            ),
          );
        },
      );
      return Effect.promise(() => handle.interrupt());
    }),
  runPromise: (spec: RunSpec) => executeChildProcess(spec).promise,
};

/**
 * `Runner` Effect service tag.
 */
export class Runner extends Context.Service<Runner, RunnerShape>()(
  "@sibylline-labs/hera/Runner",
) {
  static readonly live: Layer.Layer<Runner> = Layer.succeed(
    Runner,
    defaultRunner,
  );

  static layer(impl: RunnerShape = defaultRunner): Layer.Layer<Runner> {
    return Layer.succeed(Runner, impl);
  }

  static run(spec: RunSpec): Effect.Effect<RunResult, ErisError, Runner> {
    return Effect.flatMap(Effect.service(Runner), (runner) => runner.run(spec));
  }
}
