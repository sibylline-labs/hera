// A two-plugin manifest plus an extension, shaped like eris's `yak` and `skills` verbs. It imports
// only the pure manifest sub-plane, so loading it (for help or completion) loads no handler.
import {
  composeProgram,
  defineArgs,
  defineExtension,
  defineGroup,
  definePlugin,
  defineVerb,
  flag,
  hookPoint,
  operand,
} from "../../../src/cli/manifest/index.js";

export interface YakSubmission {
  readonly summary: string;
  readonly repos: readonly string[];
  readonly project?: string;
}

/** The payload `yak issue` sends; an extension may add to it. */
export const yakSubmission = hookPoint<YakSubmission>("yak.submission");

export const issueArgs = defineArgs({
  flags: {
    summary: flag.string({ summary: "One-line title of the report", required: true }),
    repo: flag.string({
      summary: "A repository the report concerns",
      repeatable: true,
      completeValue: [{ domain: "@repos", helper: "__fixture_dom_repos() { echo hera eris; }" }],
    }),
    format: flag.string({ summary: "Body format", choices: ["md", "txt"] }),
    count: flag.number({ summary: "How many times it happened", int: true }),
    noRedact: flag.boolean({ summary: "Skip the outbound redaction scan", alias: "-n" }),
  },
});

export const lintArgs = defineArgs({
  flags: { strict: flag.boolean({ summary: "Fail on warnings" }) },
  operands: { dir: operand.optional({ summary: "Directory to lint", complete: ["@file"] }) },
});

export const projectArgs = defineArgs({
  flags: {
    project: flag.string({
      summary: "Linear project id or near-exact name to file into",
      maxLength: 200,
      valueName: "id|name",
    }),
  },
});

export const yakPlugin = definePlugin({
  name: "yak",
  commands: {
    yak: defineGroup({
      summary: "File harness feedback",
      commands: {
        issue: defineVerb({
          summary: "File a harness issue",
          ...issueArgs,
          json: true,
          example: "fixture yak issue --summary 'hook blocks a legal edit'",
          load: () => import("./issue-handler.js").then((m) => m.issueHandler),
        }),
      },
    }),
  },
});

export const skillsPlugin = definePlugin({
  name: "skills",
  commands: {
    skills: defineGroup({
      summary: "Work with agent skills",
      commands: {
        lint: defineVerb({
          summary: "Check every skill under a directory",
          ...lintArgs,
          load: () => import("./lint-handler.js").then((m) => m.lintHandler),
        }),
      },
    }),
  },
});

export const projectPlugin = definePlugin({
  name: "yak-project",
  commands: {},
  extends: {
    "yak issue": defineExtension({
      flags: projectArgs.flags,
      load: () => import("./project-hooks.js").then((m) => m.projectHooks),
    }),
  },
});

export const fixtureProgram = composeProgram({
  name: "fixture",
  version: "1.2.3",
  plugins: [yakPlugin, skillsPlugin, projectPlugin],
});
