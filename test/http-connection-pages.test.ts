import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { HeraError } from "../src/core/errors/index.js";
import { type HeraConnectionPage, HeraHttp } from "../src/core/http/index.js";

/**
 * A Linear-shaped `projects(first, after)` connection over `total` projects, `first` per page,
 * cursors `c<n>`; every request's `after` is recorded.
 */
async function fakeProjects(total: number, first: number): Promise<{ url: string; afters: Array<string | null> }> {
  const afters: Array<string | null> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { variables } = JSON.parse(raw) as { variables: { after: string | null } };
      afters.push(variables.after);
      const start = variables.after === null ? 0 : Number(variables.after.slice(1));
      const end = Math.min(start + first, total);
      const nodes = Array.from({ length: end - start }, (_, i) => ({ id: `p${start + i}` }));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: { projects: { nodes, pageInfo: { hasNextPage: end < total, endCursor: end < total ? `c${end}` : null } } },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, afters };
}

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    s?.closeAllConnections?.();
    await new Promise<void>((r) => s?.close(() => r()));
  }
});

const ProjectsData = Schema.Struct({
  projects: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  }),
});

async function failureOf<E>(effect: Effect.Effect<unknown, E>): Promise<E> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") throw new Error("expected a typed failure, not a defect");
  return reason.error;
}

/** A page from a scripted list; `calls` records each `(after, index)` the pager asked for. */
function scripted<N>(pages: ReadonlyArray<HeraConnectionPage<N>>) {
  const calls: Array<[string | null, number]> = [];
  const page = (after: string | null, index: number) => {
    calls.push([after, index]);
    return Effect.succeed(pages[index]!);
  };
  return { calls, page };
}

const more = (cursor: string | null) => ({ nodes: [1], pageInfo: { hasNextPage: true, endCursor: cursor } });

describe("HeraHttp.connectionPages", () => {
  // admits: integration: the AC, over a real socket: one hook call per page with the previous cursor (where a caller takes its per-page lease), nodes in page order; call order is runtime
  it("reads every page through HeraHttp.graphql, one hook call per page with the previous cursor", async () => {
    const fake = await fakeProjects(5, 2);
    const hooks: Array<[string | null, number]> = [];

    const nodes = await Effect.runPromise(
      HeraHttp.connectionPages({
        maxPages: 10,
        page: (after, index) => {
          hooks.push([after, index]);
          return HeraHttp.graphql({
            url: fake.url,
            query: "query($first: Int!, $after: String) { projects(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }",
            variables: { first: 2, after },
            schema: ProjectsData,
          }).pipe(Effect.map(({ data }) => data.projects));
        },
      }),
    );

    expect(nodes.map((n) => n.id)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(hooks).toEqual([[null, 0], ["c2", 1], ["c4", 2]]);
    expect(fake.afters).toEqual([null, "c2", "c4"]);
  });

  // admits: algorithmic: the cap fails typed and never requests (or leases) a page past it; an invalid cap fails before any page; page counts are runtime
  it("fails truncated at the cap and never requests a page past it", async () => {
    const { calls, page } = scripted([more("c1"), more("c2"), more("c3")]);

    const error = await failureOf(HeraHttp.connectionPages({ page, maxPages: 2 }));

    expect(error).toMatchObject({ _tag: "HeraError", code: "upstream_error", httpStatus: 502, fields: { reason: "truncated", maxPages: 2 } });
    expect(calls).toEqual([[null, 0], ["c1", 1]]);

    const invalid = scripted([more("c1")]);
    const bad = await failureOf(HeraHttp.connectionPages({ page: invalid.page, maxPages: 0 }));
    expect(bad).toMatchObject({ _tag: "HeraError", code: "internal_error", fields: { reason: "invalid_max_pages" } });
    expect(invalid.calls).toEqual([]);
  });

  // admits: algorithmic: a page's own typed error passes through unchanged (a caller's catch by code still matches) and no partial list is answered
  it("a mid-read page failure fails the read with that page's error", async () => {
    const leaseRefused = new HeraError({ code: "rate_limited", httpStatus: 429 });
    const calls: number[] = [];
    const page = (_after: string | null, index: number) => {
      calls.push(index);
      return index === 1 ? Effect.fail(leaseRefused) : Effect.succeed(more(`c${index + 1}`));
    };

    const error = await failureOf(HeraHttp.connectionPages({ page, maxPages: 5 }));

    expect(error).toBe(leaseRefused);
    expect(calls).toEqual([0, 1]);
  });

  // admits: boundary-io: a reply with no pageInfo cannot prove the connection ended, so it is rejected, not answered
  it("rejects a page with no pageInfo", async () => {
    for (const pageInfo of [undefined, null, {}]) {
      const { page } = scripted([{ nodes: [1], pageInfo }]);
      const error = await failureOf(HeraHttp.connectionPages({ page, maxPages: 5 }));
      expect(error).toMatchObject({ code: "upstream_error", fields: { reason: "missing_page_info", page: 0 } });
    }
  });

  // admits: boundary-io: hasNextPage with a null, missing or empty endCursor is rejected rather than ending the read early
  it("rejects hasNextPage with no endCursor", async () => {
    for (const last of [more(null), { nodes: [1], pageInfo: { hasNextPage: true } }, more("")]) {
      const { calls, page } = scripted([more("c1"), last]);
      const error = await failureOf(HeraHttp.connectionPages({ page, maxPages: 5 }));
      expect(error).toMatchObject({ code: "upstream_error", fields: { reason: "missing_end_cursor", page: 1 } });
      expect(calls).toHaveLength(2);
    }
  });
});
