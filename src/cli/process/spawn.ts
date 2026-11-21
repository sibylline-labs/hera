import { type ChildProcess, spawn } from "node:child_process";
import { scrubFreeText } from "../errors/scrubber.js";
import { isPidAlive } from "../fs/lock-helpers.js";
import { psSnapshot, signalTree, subtree } from "./runner.js";
import type { RunResult, RunSpec } from "./types.js";

const DEFAULT_KILL_GRACE_MS = 2_000;
const POST_SIGKILL_PIPE_WAIT_MS = 50;

/**
 * Builds child environment, stripping `BUN_CONFIG_VERBOSE_FETCH` and setting
 * `_ERIS_SHIM_IGNORED="1"`.
 */
export function buildChildEnv(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }
  delete merged.BUN_CONFIG_VERBOSE_FETCH;
  merged._ERIS_SHIM_IGNORED = "1";
  return merged;
}

const liveChildren = new Set<ChildProcess>();
let exitHandlersInstalled = false;

function installExitHandlers(): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  process.on("exit", () => {
    for (const child of liveChildren) {
      if (child.pid !== undefined) signalTree(child.pid, "SIGTERM");
    }
  });
}

function destroyChildStreams(proc: ChildProcess): void {
  try {
    proc.stdout?.destroy();
    proc.stderr?.destroy();
    proc.stdin?.destroy();
  } catch {
    // Ignore pipe destroy errors
  }
}

function signalProcOrTree(
  proc: ChildProcess,
  sig: NodeJS.Signals,
  trackedPids: Set<number>,
): void {
  if (proc.pid !== undefined) {
    for (const p of signalTree(proc.pid, sig, trackedPids)) trackedPids.add(p);
  } else {
    try {
      proc.kill(sig);
    } catch {
      // Ignore
    }
  }
}

export function executeChildProcess(spec: RunSpec): {
  readonly promise: Promise<RunResult>;
  readonly interrupt: () => Promise<void>;
} {
  installExitHandlers();

  const killGraceMs = spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let child: ChildProcess | undefined;
  let settled = false;
  let timedOut = false;
  let escalated = false;
  let spawned = false;
  const trackedPids = new Set<number>();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let escalateTimer: ReturnType<typeof setTimeout> | undefined;
  let postKillTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (escalateTimer !== undefined) clearTimeout(escalateTimer);
    if (postKillTimer !== undefined) clearTimeout(postKillTimer);
    timeoutTimer = escalateTimer = postKillTimer = undefined;
  };

  let resolvePromise!: (res: RunResult) => void;

  const promise = new Promise<RunResult>((resolve) => {
    resolvePromise = resolve;

    try {
      child = spawn(spec.cmd, [...(spec.args ?? [])], {
        cwd: spec.cwd,
        env: buildChildEnv(spec.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      settled = true;
      const msg = err instanceof Error ? err.message : String(err);
      resolve({
        exitCode: 127,
        stdout: "",
        stderr: scrubFreeText(msg).text,
        timedOut: false,
      });
      return;
    }

    const proc = child;
    liveChildren.add(proc);
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      liveChildren.delete(proc);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut,
        ...(escalated ? { escalated: true } : {}),
        ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
      });
    };

    proc.once("spawn", () => {
      spawned = true;
      if (proc.pid !== undefined) trackedPids.add(proc.pid);
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      outChunks.push(chunk);
      if (spec.streamStdout === true) process.stdout.write(chunk);
      else if (typeof spec.streamStdout === "function") {
        spec.streamStdout(chunk.toString("utf8"));
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      errChunks.push(chunk);
      if (spec.streamStderr === true) process.stderr.write(chunk);
      else if (typeof spec.streamStderr === "function") {
        spec.streamStderr(chunk.toString("utf8"));
      }
    });

    if (spec.stdin !== undefined && proc.stdin) {
      proc.stdin.on("error", () => {});
      proc.stdin.write(spec.stdin);
      proc.stdin.end();
    } else if (proc.stdin) {
      proc.stdin.end();
    }

    if (spec.timeoutMs !== undefined && spec.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        signalProcOrTree(proc, "SIGTERM", trackedPids);
        escalateTimer = setTimeout(() => {
          if (settled) return;
          escalated = true;
          signalProcOrTree(proc, "SIGKILL", trackedPids);
          postKillTimer = setTimeout(() => {
            if (!settled) {
              destroyChildStreams(proc);
              finish(124);
            }
          }, POST_SIGKILL_PIPE_WAIT_MS);
          postKillTimer.unref?.();
        }, killGraceMs);
        escalateTimer.unref?.();
      }, spec.timeoutMs);
      timeoutTimer.unref?.();
    }

    proc.on("error", (err) => {
      if (!spawned) {
        errChunks.push(Buffer.from(scrubFreeText(err.message).text, "utf8"));
        finish(127);
      }
    });

    proc.on("close", (code) => {
      if (timedOut && proc.pid !== undefined) {
        for (const p of subtree(proc.pid, psSnapshot())) trackedPids.add(p);
        const surviving = Array.from(trackedPids).some(
          (p) => p !== proc.pid && isPidAlive(p),
        );
        if (surviving && !escalated) return;
      }
      finish(code);
    });
  });

  const interrupt = async (): Promise<void> => {
    clearTimers();
    const proc = child;
    if (!proc) return;
    liveChildren.delete(proc);

    const rootPid = proc.pid;
    if (rootPid !== undefined) {
      signalProcOrTree(proc, "SIGTERM", trackedPids);
      const deadline = Date.now() + killGraceMs;
      while (
        Date.now() < deadline &&
        Array.from(trackedPids).some(isPidAlive)
      ) {
        await new Promise((r) => setTimeout(r, 15));
      }
      if (Array.from(trackedPids).some(isPidAlive)) {
        escalated = true;
        signalProcOrTree(proc, "SIGKILL", trackedPids);
        const killDeadline = Date.now() + POST_SIGKILL_PIPE_WAIT_MS;
        while (
          Date.now() < killDeadline &&
          Array.from(trackedPids).some(isPidAlive)
        ) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    } else {
      signalProcOrTree(proc, "SIGKILL", trackedPids);
    }

    destroyChildStreams(proc);
    if (!settled) {
      settled = true;
      resolvePromise({
        exitCode: 130,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...(escalated ? { escalated: true } : {}),
        ...(rootPid !== undefined ? { pid: rootPid } : {}),
      });
    }
  };

  return { promise, interrupt };
}
