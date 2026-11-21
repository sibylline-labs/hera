import { Effect } from "effect";
import { ErisError, HeraCli } from "../../../src/cli/index.js";
import "./loaded-marker.js";
import { projectArgs, yakSubmission } from "./manifest.js";

/** Attaches `--project` to the submission; an empty value is refused. */
export const projectHooks = HeraCli.extensionHooks(projectArgs, [
  HeraCli.on(yakSubmission, (payload, args) => {
    if (args.project === undefined) return Effect.succeed(payload);
    const trimmed = args.project.trim();
    if (trimmed.length === 0) {
      return Effect.fail(ErisError.usage("yak-project-empty", { what: "--project must not be empty" }));
    }
    return Effect.succeed({ ...payload, project: trimmed });
  }),
]);
