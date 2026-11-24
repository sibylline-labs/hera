import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { HeraError } from "../src/core/errors/index.js";
import { HeraHttp } from "../src/core/http/index.js";

/**
 * A Linear-shaped GraphQL server: `issueCreate` / `commentCreate` store the entity under the
 * client-chosen `input.id` (a second create under a held id is a GraphQL error), `issue(id)` /
 * `comment(id)` read it back. `loseNextReply` stores the next create, then answers 503, so the
 * caller sees a failure for a write that landed.
 */
interface FakeLinear {
  readonly url: string;
  readonly creates: string[];
  readonly reads: string[];
  readonly held: Map<string, { readonly id: string; readonly body: string }>;
  loseNextReply: boolean;
  rateLimitNext: boolean;
}

const servers: Server[] = [];

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function fakeLinear(): Promise<FakeLinear> {
  const fake: Omit<FakeLinear, "url"> & { url: string } = {
    url: "",
    creates: [],
    reads: [],
    held: new Map(),
    loseNextReply: false,
    rateLimitNext: false,
  };
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { query, variables } = JSON.parse(raw) as {
        query: string;
        variables: { input?: { id: string; body?: string; title?: string }; id?: string };
      };
      const mutation = /(issueCreate|commentCreate)/.exec(query)?.[1];
      if (mutation !== undefined) {
        const input = variables.input!;
        fake.creates.push(input.id);
        if (fake.rateLimitNext) {
          fake.rateLimitNext = false;
          return reply(res, 400, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] });
        }
        if (fake.held.has(input.id)) {
          return reply(res, 200, { errors: [{ message: "Entity already exists", extensions: { code: "INVALID_INPUT" } }] });
        }
        const entity = { id: input.id, body: input.body ?? input.title ?? "" };
        fake.held.set(input.id, entity);
        if (fake.loseNextReply) {
          fake.loseNextReply = false;
          return reply(res, 503, { errors: [{ message: "upstream timeout" }] });
        }
        const key = mutation === "issueCreate" ? "issue" : "comment";
        return reply(res, 200, { data: { [mutation]: { success: true, [key]: entity } } });
      }
      const read = /\b(issue|comment)\(id/.exec(query)?.[1]!;
      fake.reads.push(variables.id!);
      return reply(res, 200, { data: { [read]: fake.held.get(variables.id!) ?? null } });
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    s?.closeAllConnections?.();
    await new Promise<void>((r) => s?.close(() => r()));
  }
});

const Entity = Schema.Struct({ id: Schema.String, body: Schema.String });
type Entity = typeof Entity.Type;

/** One Linear create and its read-back by id, as an app's Linear client writes them. */
function linearOnce(fake: FakeLinear, kind: "issue" | "comment", input: { id: string; body: string }, owns?: (found: Entity) => boolean) {
  const mutation = kind === "issue" ? "issueCreate" : "commentCreate";
  const inputType = kind === "issue" ? "IssueCreateInput" : "CommentCreateInput";
  const field = kind === "issue" ? { id: input.id, title: input.body } : input;
  return HeraHttp.createOnce({
    create: HeraHttp.graphql({
      url: fake.url,
      query: `mutation($input: ${inputType}!) { ${mutation}(input: $input) { success ${kind} { id body } } }`,
      variables: { input: field },
      schema: Schema.Struct({ [mutation]: Schema.Struct({ success: Schema.Boolean, [kind]: Entity }) }),
    }).pipe(Effect.map(({ data }) => (data[mutation] as unknown as Record<string, Entity>)[kind]!)),
    find: HeraHttp.graphql({
      url: fake.url,
      query: `query($id: String!) { ${kind}(id: $id) { id body } }`,
      variables: { id: input.id },
      schema: Schema.Struct({ [kind]: Schema.NullOr(Entity) }),
    }).pipe(Effect.map(({ data }) => data[kind] ?? null)),
    owns,
  });
}

async function failureOf<E>(effect: Effect.Effect<unknown, E>): Promise<E> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") throw new Error("expected a typed failure, not a defect");
  return reason.error;
}

describe("HeraHttp.createOnce", () => {
  // admits: integration: an issueCreate whose reply is lost, retried, must answer the stored issue with one create on the wire; request counts are runtime
  it("issueCreate retried after a lost reply returns the same issue, one create recorded", async () => {
    const fake = await fakeLinear();
    fake.loseNextReply = true;
    const input = { id: "8d3c1f9e-0a4b-4c55-9b6e-1f2a3b4c5d6e", body: "File the review Epic" };

    const first = await Effect.runPromise(linearOnce(fake, "issue", input));

    expect(first).toEqual({ _tag: "Found", value: { id: input.id, body: input.body } });
    expect(fake.creates).toEqual([input.id]);
    expect(fake.reads).toEqual([input.id]);
  });

  // admits: integration: the Created/Found tag drives a caller's 201 vs 200 for comments; a runtime branch no type fixes
  it("commentCreate: a fresh create is Created, its replay after a lost reply is Found", async () => {
    const fake = await fakeLinear();
    const fresh = { id: "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d", body: "receipt" };
    expect(await Effect.runPromise(linearOnce(fake, "comment", fresh))).toEqual({ _tag: "Created", value: fresh });
    expect(fake.reads).toEqual([]);

    // The same create sent again (its first reply lost to the caller): Linear refuses the held id.
    expect(await Effect.runPromise(linearOnce(fake, "comment", fresh))).toEqual({ _tag: "Found", value: fresh });
    expect(fake.held.size).toBe(1);
  });

  // admits: algorithmic: a failed create with nothing under the id must fail with the create's own error, never read as success (fail closed)
  it("re-raises the create error when nothing holds the id", async () => {
    const createError = new HeraError({ code: "service_unavailable", httpStatus: 503 });
    const error = await failureOf(
      HeraHttp.createOnce({ create: Effect.fail(createError), find: Effect.succeed(null) }),
    );
    expect(error).toBe(createError);
  });

  // admits: algorithmic: an entity under the id that is not this create's write must be a 409 conflict, never Found
  it("answers conflict when another write holds the id", async () => {
    const fake = await fakeLinear();
    const id = "2c3d4e5f-6071-4b2c-9d3e-4f5a6b7c8d9e";
    fake.held.set(id, { id, body: "someone else's comment" });

    const error = await failureOf(linearOnce(fake, "comment", { id, body: "mine" }, (found) => found.body === "mine"));

    expect(HeraError.is(error) && error.code === "conflict" && error.httpStatus === 409).toBe(true);
  });

  // admits: boundary-io: Linear's 400 RATELIMITED is classified from the wire error, and a rate-limited create reads nothing back
  it("skips the read-back on a rate limit", async () => {
    const fake = await fakeLinear();
    fake.rateLimitNext = true;

    const error = await failureOf(linearOnce(fake, "issue", { id: "3d4e5f60-7182-4c3d-8e4f-5a6b7c8d9e0f", body: "x" }));

    expect(error).toMatchObject({ _tag: "HeraHttpError", status: 400 });
    expect(fake.reads).toEqual([]);
  });
});
