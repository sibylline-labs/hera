import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { scrubFreeText } from "../src/cli/errors/index.js";
import { AWS_EXAMPLE_KEY, GCP_KEY_BODY, JWT_HS256, SLACK_BOT_TOKEN_SHORT } from "./fixtures/provider-tokens.js";

const GH = `gh${"p_"}${"0".repeat(36)}`;
const ULID = "01HZY3N8Q2W5K7M9P1R3T5V7X9";

/** Scrubs once, asserts the secret is gone and a second scrub is a no-op, returns the first result. */
function scrubbed(raw: string, secret: string) {
  const once = scrubFreeText(raw);
  expect(once.text, raw).not.toContain(secret);
  const twice = scrubFreeText(once.text);
  expect(twice.text, raw).toBe(once.text);
  expect(twice.redactions, raw).toEqual([]);
  return once;
}

describe("scrubFreeText never ships a credential tail glued to an earlier class's marker", () => {
  // admits: a marker guard that declines any value starting with a marker, shipping the tail after
  // it (`<redacted:github-token>:pass`); regex behaviour has no type.
  test.each([
    [`Authorization: Basic ${GH}:mySecretPass123`, "mySecretPass123"],
    [`Authorization: Bearer ${GH}.mySecretTail`, "mySecretTail"],
    [`x-api-key: ${GH}:mySecretTail`, "mySecretTail"],
    [`DB_PASSWORD=${GH}:mySecretTail`, "mySecretTail"],
    [`DB_PASSWORD=${GH}.mySecretTail`, "mySecretTail"],
    [`DB_PASSWORD="${GH}.mySecretTail"`, "mySecretTail"],
  ])("%s", (raw, secret) => {
    scrubbed(raw, secret);
  });

  // admits: a fixed-length class taking the head of a longer credential and stranding its tail
  // (padded sib_ tokens, non-base64 or >80-char AWS secrets); regex behaviour has no type.
  test.each([
    [`sib_${ULID}_${"A".repeat(43)}TAIL99`, "TAIL99"],
    [`ERIS_TOKEN=sib_${ULID}_${"A".repeat(43)}TAIL99`, "TAIL99"],
    [`aws_secret_access_key = ${"A".repeat(25)}_tail99`, "_tail99"],
    [`aws_secret_access_key = ${"A".repeat(80)}TAIL99`, "TAIL99"],
    [`sib_${ULID}_${"A".repeat(43)}PASSWORD=hunter2hunter2`, "hunter2hunter2"],
  ])("%s", (raw, secret) => {
    scrubbed(raw, secret);
  });
});

describe("scrubFreeText is idempotent and covers eris outbound-scan's shapes", () => {
  // admits: a late pass handing an earlier class the boundary it lacked, so the first scrub leaks
  // and the second redacts; regex behaviour has no type.
  test.each([
    [`https://u:p@${"a".repeat(255)}sk${"-ant-"}${"a".repeat(26)}`, "sk-ant-"],
    [`https://u:p@${"a".repeat(255)}Authorization: Basic dXNlcjphYmM=`, "dXNlcjphYmM"],
    [`postgres://user:${GH}%21PLAINTAIL@db.example.com/app`, "PLAINTAIL"],
  ])("%s", (raw, secret) => {
    scrubbed(raw, secret);
  });

  // admits: a shape eris redacts that Hera ships (a non-PEM JSON private_key, an RFC 7235 scheme
  // outside Bearer/Basic/Token/Digest); regex behaviour has no type.
  test.each([
    [`{"private_key": "${GCP_KEY_BODY}"}`, "MIIEvQIBADAN", "gcp-private-key"],
    ["Authorization: Negotiate YIIFGAYJKoZIhvcNAQcCoIIFCTCCBQU=", "YIIFGAYJ", "auth-header"],
    ["Authorization: Hawk aWQ9ZGgzN2ZnajQ5MmplLHRzPTEzNTM4MzI=", "aWQ9ZGgz", "auth-header"],
  ])("%s", (raw, secret, cls) => {
    expect(scrubbed(raw, secret).redactions).toContain(cls);
  });

  // admits: any concatenation of credential shapes and separators whose first scrub is not a fixed
  // point; regex interplay across classes has no type.
  test("any concatenation of credential fragments scrubs to a fixed point", () => {
    const fragment = fc.constantFrom(
      GH,
      `sib_${ULID}_${"A".repeat(43)}`,
      `sibdc_BCDFGHJK_${"B".repeat(43)}`,
      AWS_EXAMPLE_KEY,
      `sk${"-ant-"}${"a".repeat(26)}`,
      SLACK_BOT_TOKEN_SHORT,
      `AI${"za"}${"C".repeat(35)}`,
      JWT_HS256,
      "Authorization: Basic ",
      "Authorization: Negotiate ",
      "Bearer ",
      "x-api-key: ",
      "postgres://user:",
      "https://u:p@",
      "@db.example.com/app",
      "aws_secret_access_key = ",
      "API_TOKEN=",
      '"private_key": "',
      ":",
      ".",
      " ",
      "%21",
      "TAIL99",
      "a".repeat(40),
    );
    fc.assert(
      fc.property(fc.array(fragment, { minLength: 1, maxLength: 8 }), (parts) => {
        const once = scrubFreeText(parts.join("")).text;
        const twice = scrubFreeText(once);
        return twice.text === once && twice.redactions.length === 0;
      }),
      { numRuns: 500, seed: 4437 },
    );
  });
});

describe("scrubFreeText keeps prose, ships no password on keyword hosts, and runs in linear time", () => {
  // admits: a pass that chains off its own marker and eats the diagnostic words after it, so a
  // rendered failure block differs from the error's text; regex interplay has no type.
  test.each([
    ["API_TOKEN=hunter2 : step = pull : repo = hera : mode = fast", "API_TOKEN=<redacted:assignment> : step = pull : repo = hera : mode = fast"],
    [`${GH} : aaaa : bbbb : cccc : dddd : eeee`, "<redacted:github-token> : aaaa : bbbb : cccc : dddd : eeee"],
  ])("%s", (raw, text) => {
    const once = scrubFreeText(raw);
    expect(once.text).toBe(text);
    expect(scrubFreeText(once.text).text).toBe(once.text);
  });

  // admits: a host or key that happens to contain a governed word (`authorization.corp`, base64
  // ending `pwd=`) turning a redaction off; regex behaviour has no type.
  test.each([
    ["https://deploy:hunter2secret@authorization.corp:8080/oauth", "hunter2secret"],
    ["https://deploy:hunter2secret@token.example.com:8443/repo", "hunter2secret"],
    [`{"private_key": "${GCP_KEY_BODY}pwd="}`, "MIIEvQIBADAN"],
    [`{"private_key": "${GCP_KEY_BODY}token=="}`, "MIIEvQIBADAN"],
  ])("%s", (raw, secret) => {
    scrubbed(raw, secret);
  });

  // admits: catastrophic backtracking on long runs of governed words (a 64 KB stderr would hang a
  // CLI for minutes); time is invisible to types.
  test.each([
    `https://u:p@${"token_".repeat(10_000)}!`,
    `AIza${"C".repeat(35)}${"token_".repeat(10_000)}!`,
    `{"private_key": "${"token_".repeat(10_000)}"}`,
    `sib_${ULID}_${"A".repeat(43)}${"token_".repeat(10_000)}!`,
    `Authorization: Bearer ${"token_".repeat(10_000)}`,
    `${"password_".repeat(7_000)}=x`,
  ])("a 60 KB adversarial input scrubs in under 200 ms (%#)", (raw) => {
    const start = performance.now();
    scrubFreeText(raw);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("pass order is load-bearing (each ordering mutation fails a case)", () => {
  // admits: sibdc-code or sib-token running after a class whose shape its secret embeds (`-sk-`,
  // `ghp_`), leaving the token head in plaintext; regex ordering has no type.
  test.each([
    [`sibdc_BCDFGHJK_ab-sk-${"x".repeat(37)}`, "<redacted:sibdc-code>", ["sibdc-code"]],
    [`sib_${ULID}_ghp_${"y".repeat(39)}`, "<redacted:sib-token>", ["sib-token"]],
    [
      `Authorization: Bearer ${JWT_HS256}`,
      "Authorization: Bearer <redacted:jwt>",
      ["jwt"],
    ],
  ])("%s", (raw, text, classes) => {
    const res = scrubFreeText(raw);
    expect(res.text).toBe(text);
    expect(res.redactions).toEqual(classes);
  });
});
