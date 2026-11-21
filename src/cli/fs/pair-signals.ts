import { rmSync } from "node:fs";
import { constants as osConstants } from "node:os";

const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export interface StageGuard {
  /** The stage still exists and the guard still owns it. */
  readonly isLive: () => boolean;
  /** A signal removed the stage while a sibling listener kept the process alive. */
  readonly isSignalled: () => boolean;
  /** Delete the stage and uninstall the handlers. */
  readonly remove: () => void;
  /** Uninstall the handlers and keep the stage on disk (a failed rollback's recovery source). */
  readonly keep: () => void;
}

/**
 * Removes `path` on SIGINT / SIGTERM / SIGHUP until `remove` or `keep` is called.
 *
 * When the guard is the only listener it re-raises, so the process still dies by the signal.
 * When a sibling listener keeps the process alive, the stage is gone and the write cannot finish:
 * the siblings run, then the process exits with the shell's `128 + signal` status.
 */
export function guardStage(path: string): StageGuard {
  let live = true;
  let signalled = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const release = () => {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
    handlers.clear();
  };
  const remove = () => {
    live = false;
    release();
    rmSync(path, { recursive: true, force: true });
  };
  for (const sig of SIGNALS) {
    const h = () => {
      const removedStage = live;
      if (removedStage && process.listenerCount(sig) > 1) signalled = true;
      if (live) remove();
      else release();
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
      else if (removedStage) setImmediate(() => process.exit(128 + (osConstants.signals[sig] ?? 0)));
    };
    handlers.set(sig, h);
    process.on(sig, h);
  }
  return {
    isLive: () => live,
    isSignalled: () => signalled,
    remove,
    keep: () => {
      live = false;
      release();
    },
  };
}
