// A binary's entry, as a consumer writes it: the pure manifest answers what it can, and the
// runtime loads only for a dispatch. The completion timing test spawns this file.
import { runPure } from "../../../src/cli/manifest/index.js";
import { fixtureProgram } from "./manifest.js";

const argv = process.argv.slice(2);
const outcome = runPure(fixtureProgram, argv, { stdout: (t) => void process.stdout.write(t), env: process.env });
if (outcome._tag === "Done") {
  // The completion test reads this process's own CPU time: unlike wall time, it does not grow
  // when other test files load the machine.
  if (process.env.HERA_CLI_TIMING === "1") {
    const cpu = process.cpuUsage();
    process.stderr.write(`HERA_CLI_CPU_MS=${((cpu.user + cpu.system) / 1000).toFixed(1)}\n`);
  }
  process.exit(0);
}
const { runProgram } = await import("../../../src/cli/runtime/index.js");
process.exit(await runProgram(fixtureProgram, argv));
