import { Effect } from "effect";
import { HeraCli, fn } from "../../../src/cli/index.js";
import "./loaded-marker.js";
import { issueArgs, yakSubmission } from "./manifest.js";

/** Sends the submission through the hook point and prints what an extension made of it. */
export const issueHandler = HeraCli.handler(issueArgs, (args, ctx) =>
  fn("FixtureYak.issue")(function* () {
    const payload = yield* HeraCli.hook(yakSubmission, { summary: args.summary, repos: args.repo });
    const extra = { format: args.format ?? null, count: args.count ?? null, noRedact: args.noRedact };
    ctx.stdout(`${JSON.stringify({ payload, ...extra, json: ctx.isJson })}\n`);
    yield* Effect.void;
  })(),
);
