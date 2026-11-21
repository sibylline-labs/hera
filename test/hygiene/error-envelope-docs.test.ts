import * as fs from "node:fs";
import * as path from "node:path";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { toProblemResponse } from "../../src/core/http/index";
import { Hera, HeraError, OrgId } from "../../src/index";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const ERRORS_MD = path.join(REPO_ROOT, "docs/ERRORS.md");

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

function wireSection(): string {
  const text = fs.readFileSync(ERRORS_MD, "utf8");
  const start = text.indexOf("## 2. Error Envelope Wire Format");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

const PROBLEM_JSON = "application/problem+json; charset=utf-8";

function orgsCreateRoute() {
  return Hera.publicRoute({
    name: "Orgs.create",
    service: "polaris-accounts",
    body: Schema.Struct({ orgId: OrgId }),
    handler: () => Hera.fn("Orgs.create")(function* () {
      return {};
    })(),
  });
}

// The documented boundary wire is the one a route actually emits: RFC 7807 with `code`.
describe("docs/ERRORS.md §2 — error envelope matches the route boundary wire", () => {
  it("a real publicRoute 400 is problem+json, deep-equals the documented example, and carries no `ok`", async () => {
    const section = wireSection();
    const block = /```json\n([\s\S]*?)```/.exec(section);
    expect(block).not.toBeNull();
    const documented = JSON.parse(block?.[1] ?? "") as Record<string, unknown>;

    const res = await orgsCreateRoute().handle(
      new Request("https://api.example.com/orgs", {
        method: "POST",
        headers: { "x-request-id": String(documented.request_id) },
        body: JSON.stringify({ orgId: "not-an-org-id" }),
      }),
      { params: {} },
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe(PROBLEM_JSON);
    expect(section).toContain(`Content-Type: ${PROBLEM_JSON}`);
    expect(body).toMatchObject({
      type: "urn:hera:error:invalid_request_body",
      title: "Invalid request body",
      status: 400,
      detail: "Invalid request body",
      code: "invalid_request_body",
    });
    expect(body).not.toHaveProperty("ok");
    expect(body).toEqual(documented);
  });

  it("toProblemResponse and HeraError.toResponse share one serializer", async () => {
    const err = HeraError.rateLimited(undefined, { retryAfter: 30, requestId: "req_1" });
    const viaHelper = toProblemResponse(err, { headers: { "x-extra": "1" } });
    const viaError = err.toResponse({ headers: { "x-extra": "1" } });

    expect(viaHelper.status).toBe(viaError.status);
    expect([...viaHelper.headers]).toEqual([...viaError.headers]);
    expect(await viaHelper.text()).toBe(await viaError.text());
  });

  it("no doc presents the boundary error as an application/json `{ ok:false }` envelope", () => {
    const docs = [
      path.join(REPO_ROOT, "README.md"),
      ...markdownFiles(path.join(REPO_ROOT, "docs")),
      ...markdownFiles(path.join(REPO_ROOT, "skills")),
    ];
    const offending = docs.flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${path.relative(REPO_ROOT, file)}:${i + 1}` }))
        .filter(({ line }) =>
          /\bnot rfc ?(7807|9457)/i.test(line) ||
          (/application\/json/i.test(line) && /error|envelope/i.test(line)),
        )
        .map(({ at }) => at),
    );
    expect(offending).toEqual([]);
  });
});
