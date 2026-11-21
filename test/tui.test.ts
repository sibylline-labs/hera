import { describe, expect, it } from "vitest";
import { HeraTui, type TuiAnswers } from "../src/cli/tui/index";

const recordSteps = [
  HeraTui.prompt("title", "Title", {
    validate: (v: string) => (v.length < 3 ? "At least 3 characters." : undefined),
  }),
  HeraTui.select(
    "kind",
    "Entry kind",
    [
      { value: "lbd", label: "Load-bearing decision" },
      { value: "practice", label: "Practice" },
    ],
    { default: "lbd" },
  ),
  HeraTui.prompt("practiceDoc", "Practices doc", {
    when: (answers) => answers["kind"] === "practice",
  }),
  HeraTui.confirm("submit", "Submit now?", { default: true }),
] as const;

describe("hera/tui headless step flow", () => {
  it("drives prompt, select and confirm from scripted lines and returns typed answers", async () => {
    const scripted = HeraTui.scriptedIo(["Ship it", "2", "Practices — hera", "n"]);
    const result = await HeraTui.run(recordSteps, scripted.io);

    expect(result).toEqual({
      status: "done",
      answers: { title: "Ship it", kind: "practice", practiceDoc: "Practices — hera", submit: false },
    });
    expect(scripted.remaining()).toBe(0);
    expect(scripted.transcript()).toBe(
      [
        "Title: Ship it",
        "Entry kind",
        "  1) Load-bearing decision",
        "  2) Practice",
        "Choose 1-2 [1]: 2",
        "Practices doc: Practices — hera",
        "Submit now? [Y/n]: n",
        "",
      ].join("\n"),
    );
  });

  it("skips a step whose `when` is false, takes defaults on empty input, and accepts a select value", async () => {
    const scripted = HeraTui.scriptedIo(["Ship it", "", ""]);
    const result = await HeraTui.run(recordSteps, scripted.io);
    expect(result).toEqual({
      status: "done",
      answers: { title: "Ship it", kind: "lbd", practiceDoc: undefined, submit: true },
    });

    const byValue = await HeraTui.run(
      [HeraTui.select("kind", "Kind", [{ value: "lbd" }, { value: "practice" }])] as const,
      HeraTui.scriptedIo(["practice"]).io,
    );
    expect(byValue).toEqual({ status: "done", answers: { kind: "practice" } });
  });

  it("re-asks on invalid input with the reason, for every step kind", async () => {
    const scripted = HeraTui.scriptedIo(["ab", "Ship it", "9", "x", "1", "maybe", "yes"]);
    const result = await HeraTui.run(recordSteps, scripted.io);

    expect(result.status).toBe("done");
    expect(result.answers).toMatchObject({ title: "Ship it", kind: "lbd", submit: true });
    const transcript = scripted.transcript();
    expect(transcript).toContain("Title: ab\n  At least 3 characters.\nTitle: Ship it\n");
    expect(transcript).toContain("Choose 1-2 [1]: 9\n  Enter a number from 1 to 2.\n");
    expect(transcript).toContain("Choose 1-2 [1]: x\n  Enter a number from 1 to 2.\n");
    expect(transcript).toContain("Submit now? [Y/n]: maybe\n  Answer y or n.\n");
  });

  it("requires a value for a prompt with no default", async () => {
    const scripted = HeraTui.scriptedIo(["", "  ok  "]);
    const result = await HeraTui.run([HeraTui.prompt("name", "Name")] as const, scripted.io);
    expect(result).toEqual({ status: "done", answers: { name: "ok" } });
    expect(scripted.transcript()).toContain("  A value is required.\n");
  });

  it("cancels at the step where input ends, keeping earlier answers", async () => {
    const result = await HeraTui.run(recordSteps, HeraTui.scriptedIo(["Ship it"]).io);
    expect(result).toEqual({ status: "cancelled", at: "kind", answers: { title: "Ship it" } });
  });

  it("terminalIo reads lines across unaligned byte chunks, CRLF and a missing final newline", async () => {
    const encoder = new TextEncoder();
    async function* stdin() {
      yield encoder.encode("Ship");
      yield encoder.encode(" it\r\n2\n");
      yield "y";
    }
    let written = "";
    const io = HeraTui.terminalIo({ input: stdin(), output: { write: (text) => (written += text) } });
    const result = await HeraTui.run(recordSteps, io);
    expect(result).toEqual({
      status: "cancelled",
      at: "submit",
      answers: { title: "Ship it", kind: "practice", practiceDoc: "y" },
    });
    expect(written).toContain("Practices doc: ");

    const reader = HeraTui.lineReader((async function* () {
      yield encoder.encode("a\n\nb");
    })());
    expect([await reader(), await reader(), await reader(), await reader()]).toEqual(["a", "", "b", null]);
  });

  it("types answers from the step list", () => {
    type Answers = TuiAnswers<typeof recordSteps>;
    const answers: Answers = { title: "t", kind: "practice", practiceDoc: undefined, submit: true };
    expect(answers.kind).toBe("practice");

    // @ts-expect-error select answers are the option values only
    const badKind: Answers = { title: "t", kind: "other", practiceDoc: undefined, submit: true };
    // @ts-expect-error confirm answers are booleans
    const badSubmit: Answers = { title: "t", kind: "lbd", practiceDoc: undefined, submit: "yes" };
    // @ts-expect-error a step without `when` is always answered
    const missingTitle: Answers = { kind: "lbd", practiceDoc: undefined, submit: true };
    // @ts-expect-error a select default must be one of its options
    HeraTui.select("k", "K", [{ value: "a" }], { default: "b" });
    expect([badKind, badSubmit, missingTitle]).toHaveLength(3);
  });
});
