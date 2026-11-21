/**
 * Starts a pair write into <dir> and holds it mid-write, printing `holding` once there, so
 * test/cli-pair-writer.test.ts can deliver a real signal from outside. The hold parks at <step>
 * (a PairStep); the default, `write-plain`, is after the stage exists and `.env` is being
 * written, before the secret file is staged.
 *
 * `--sibling-listener` registers a SIGTERM listener that does nothing, the way an embedding host's
 * own handler sits beside the writer's. `--settling-listener` registers one that also lets the
 * held step settle, the way a host aborts in-flight work on the same signal. `--dev-vars` hands the
 * writer bytes for a third file.
 *
 * `rename-*` and `rollback-*` run inside the synchronous rename set, where a returned promise is
 * not awaited, so a hold there blocks the thread: that is for SIGKILL only.
 *
 *   bun test/fixtures/pair-writer-hold.ts <dir> [step] [--dev-vars] [--sibling-listener] [--settling-listener]
 */
import { writeSync } from "node:fs";
import { type PairStep, writePair } from "../../src/cli/fs/atomic-pair-writer.js";

const args = process.argv.slice(2);
const withDevVars = args.includes("--dev-vars");
const [dir, step] = args.filter((a) => !a.startsWith("--"));
if (!dir) {
  process.stderr.write("usage: pair-writer-hold.ts <dir> [step] [--dev-vars]\n");
  process.exit(2);
}
if (args.includes("--sibling-listener")) process.on("SIGTERM", () => {});
let settleHold: () => void = () => {};
if (args.includes("--settling-listener")) process.on("SIGTERM", () => settleHold());
const holdAt = (step ?? "write-plain") as PairStep;
const inRenameSet = /^(rename|rollback)-/.test(holdAt);

await writePair(
  dir,
  "NEW=2\n",
  "S=new\n",
  {
    faults: (s) => {
      if (s !== holdAt) return;
      writeSync(1, "holding\n");
      if (inRenameSet) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return new Promise<void>((resolve) => {
        settleHold = resolve;
        setInterval(() => {}, 1000);
      });
    },
  },
  withDevVars ? "NEW_DEV=2\n" : undefined,
);
process.stdout.write("completed\n");
