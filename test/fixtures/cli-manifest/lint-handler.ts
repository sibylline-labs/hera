import { ErisError, HeraCli, fn } from "../../../src/cli/index.js";
import "./loaded-marker.js";
import { lintArgs } from "./manifest.js";

export const lintHandler = HeraCli.handler(lintArgs, (args, ctx) =>
  fn("FixtureSkills.lint")(function* () {
    if (args.strict && args.dir === "bad") {
      return yield* ErisError.operational("skills-lint-failed", { what: "1 skill fails its contract" });
    }
    ctx.stdout(`linted ${args.dir ?? "."}\n`);
  })(),
);
