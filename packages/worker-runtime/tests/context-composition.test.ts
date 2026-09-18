import { requestTakibi } from "./helpers/request";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { fullAccess } from "@takibi/policy";
import {
  createTakibi,
  TAKIBI_BRAND,
  type DurableObjectFetchStub,
  type LogEvent,
} from "@takibi/worker-runtime";
import { readTakibiBrand } from "../src/brand";
import { getTestingFork, type TestingExecutorFactory } from "@takibi/worker-runtime/testing-bridge";
import { Hono } from "hono";
import { createHttpHandler } from "../src/context/http-handler";
import { createContext } from "../src/context/definition";
import { ownStringEntries } from "@takibi/worker-runtime";

// The public facade is the only dynamic type boundary. These tests cover the
// relationships that must survive it, including arguments to stored callbacks.
test("stub resolver accepts platform stubs and requires fetch", () => {
  expectTypeOf<DurableObjectStub>().toExtend<DurableObjectFetchStub>();

  const acceptStub = (_stub: DurableObjectFetchStub) => undefined;
  acceptStub({ fetch: async () => new Response() });

  const invalid = () => {
    // @ts-expect-error A stub must provide fetch.
    acceptStub({});
    // @ts-expect-error Fetch must return a Response.
    acceptStub({ fetch: async () => "invalid" });
  };
  expectTypeOf(invalid).toBeFunction();
});

test("definition facade preserves initial, env, services, documents and actions", () => {
  type Initial = { auth: { tenant: string } };
  type Env = { PREFIX: string };
  const context = createTakibi<Initial, Env>()({
    resolve: async ({ context }) => {
      expectTypeOf(context).toEqualTypeOf<Initial>();
      return { tenantId: context.auth.tenant };
    },
    services: ({ env }) => {
      expectTypeOf(env).toEqualTypeOf<Env>();
      return { format: (title: string) => env.PREFIX + title };
    },
  });
  const app = context.defineCollections({
    posts: context.defineCollection({
      schema: z.object({ title: z.string() }),
      accessPolicy: fullAccess,
    }),
  });
  const actions = app.posts.actions((define) => ({
    rename: define()
      .input(z.object({ title: z.string() }))
      .policy(fullAccess)
      .handler(({ ctx, input, services, doc }) => {
        expectTypeOf(ctx).toEqualTypeOf<{ tenantId: string }>();
        expectTypeOf(input).toEqualTypeOf<{ title: string }>();
        expectTypeOf(doc.title).toBeString();
        return { title: services.format(input.title) };
      }),
  }));
  const handler = app.actions({ posts: actions });
  expectTypeOf<Parameters<typeof handler.handle>[1]>().toExtend<{
    stripPrefix?: string | ((pathname: string) => string);
    context: Initial;
  }>();
  expectTypeOf(handler.DurableObject).constructorParameters.toEqualTypeOf<
    [DurableObjectState, Env]
  >();
  expectTypeOf(readTakibiBrand(handler).actions.posts).toEqualTypeOf<typeof actions>();
  const invalid = () => {
    // @ts-expect-error factory does not accept entry modes
    createTakibi<Initial, Env>({ entry: "hono" });
    // @ts-expect-error initial context is required
    void handler.handle(new Request("https://test/posts"), {});
    // @ts-expect-error unknown collection names must not become any
    app.absent.actions(() => ({}));
    // @ts-expect-error definition API member cannot be a collection name
    context.defineCollections({
      actions: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
    });
  };
  expectTypeOf(invalid).toBeFunction();
});

test("forks own their registry, services, logger and backend disposal", async () => {
  const originalEvents: LogEvent[] = [];
  const forkEvents: LogEvent[] = [];
  const source = createContext({
    resolve: () => ({ tenant: "original" }),
    services: (): { name: string } | null => ({ name: "production" }),
    logger: { log: (event) => originalEvents.push(event) },
  })
    .defineCollections({
      posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
    })
    .actions({});
  const fork = getTestingFork(source);
  if (!fork) throw new Error("testing fork is missing");
  const allocations: Pick<Parameters<TestingExecutorFactory>[0], "registry" | "services">[] = [];
  const disposals: number[] = [];
  const createBackend: TestingExecutorFactory = (input) => {
    const id = allocations.push(input);
    return {
      execute: async ({ ctx, initial }) => ({
        ok: true,
        data: { ...ctx, initial: initial === null ? null : "present" },
      }),
      dispose() {
        disposals.push(id);
      },
    };
  };
  expect(() => fork({}, createBackend)).toThrow("requires services");
  expect(allocations).toHaveLength(0);
  const left = fork(
    {
      services: null,
      resolve: () => ({ tenant: "left" }),
      logger: { log: (e) => forkEvents.push(e) },
    },
    createBackend,
  );
  const right = fork({ services: { name: "right" } }, createBackend);
  expect(Object.hasOwn(right, "handle")).toBe(true);
  expect(allocations[0].registry).not.toBe(allocations[1].registry);
  expect(allocations[0].services).toBeNull();
  expect(allocations[1].services).toEqual({ name: "right" });
  const response = await requestTakibi(left, "https://test/posts/p1");
  await expect(response.json()).resolves.toEqual({
    ok: true,
    data: { tenant: "left", initial: "present" },
  });
  expect(forkEvents.some((e) => e.message === "completed")).toBe(true);
  expect(originalEvents).toHaveLength(0);
  const dispose = Object.getOwnPropertyDescriptor(left, Symbol.dispose);
  expect(dispose?.enumerable).toBe(false);
  dispose?.value();
  expect(disposals).toEqual([1]);
  expect(Object.hasOwn(source, Symbol.dispose)).toBe(false);
  expect(Object.getOwnPropertyDescriptor(source, TAKIBI_BRAND)).toMatchObject({
    enumerable: false,
    writable: false,
    configurable: false,
  });
  expect(getTestingFork(left)).toBeTypeOf("function");
});

test("typed own entries preserve descriptor values and never invoke accessors", () => {
  let reads = 0;
  const entries = { value: { title: "original" } };
  const proxy = new Proxy(entries, {
    get() {
      reads++;
      throw new Error("must not read through proxy");
    },
  });
  const result = [
    ...ownStringEntries(proxy, "INVALID_COLLECTION", {
      subject: "Collections",
      keys: "Collection names",
    }),
  ];
  expectTypeOf(result).toEqualTypeOf<[string, { title: string }][]>();
  expect(result).toEqual([["value", { title: "original" }]]);
  expect(reads).toBe(0);
  const accessor = {
    get value() {
      reads++;
      return {};
    },
  };
  expect(() => [
    ...ownStringEntries(accessor, "INVALID_COLLECTION", {
      subject: "Collections",
      keys: "Collection names",
    }),
  ]).toThrow("data properties");
  expect(reads).toBe(0);
});

test("HTTP adapter preserves explicit null context and skips unmatched prefixes", async () => {
  const initialValues: unknown[] = [];
  const handler = createHttpHandler<null | Record<string, never>>(async (_request, initial) => {
    initialValues.push(initial);
    return Response.json({ ok: true });
  });
  expect(
    await handler.handle(new Request("https://test/posts/p1"), {
      stripPrefix: "/api",
      context: {},
    }),
  ).toEqual({
    matched: false,
  });
  expect(initialValues).toEqual([]);
  await handler.handle(new Request("https://test/posts/p1"), { context: null });
  await handler.handle(new Request("https://test/posts/p1"), { context: {} });
  expect(initialValues).toEqual([null, {}]);
});

test.each([
  { stripPrefix: undefined, path: "/posts/a%3Ab/" },
  { stripPrefix: "/api/", path: "/api/posts/a%3Ab/" },
  { stripPrefix: "", path: "/posts/a%3Ab/" },
  { stripPrefix: "/", path: "/posts/a%3Ab/" },
  { stripPrefix: (path: string) => path.slice("/api".length), path: "/api/posts/a%3Ab/" },
])(
  "HTTP stripPrefix decodes $path and preserves the original request",
  async ({ stripPrefix, path }) => {
    const request = new Request(`https://test${path}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "updated" }),
    });
    const handler = createHttpHandler(async (raw, _initial, decode) => {
      expect(raw).toBe(request);
      expect(raw.url).toBe(`https://test${path}`);
      expect(await decode()).toEqual({
        kind: "collection",
        collection: "posts",
        operation: "update",
        id: "a:b",
        input: { title: "updated" },
      });
      return new Response();
    });
    expect(await handler.handle(request, { stripPrefix, context: {} })).toMatchObject({
      matched: true,
    });
  },
);

test("string stripPrefix does not claim neighboring paths", async () => {
  const handler = createHttpHandler(async () => {
    throw new Error("unmatched requests must not be served");
  });
  expect(
    await handler.handle(new Request("https://test/apix/posts"), {
      stripPrefix: "/api",
      context: {},
    }),
  ).toEqual({ matched: false });
});

test("core HTTP entry preserves its value and rejects the Hono surface", async () => {
  const seen: ({ token: string } | null)[] = [];
  const handler = createTakibi<{ token: string } | null>()({
    resolve: async ({ context }) => {
      seen.push(context);
      return { tenantId: context?.token ?? "anonymous" };
    },
  })
    .defineCollections({})
    .actions({});
  const fork = getTestingFork(handler);
  if (!fork) throw new Error("missing fork");
  const local = fork({}, () => ({
    execute: async ({ ctx }) => ({ ok: true, data: ctx }),
    dispose() {},
  }));
  for (const context of [{ token: "session" }, null]) {
    const result = await local.handle(new Request("https://test/posts/p1"), { context });
    expect(result.matched).toBe(true);
  }
  expect(seen).toEqual([{ token: "session" }, null]);
  expect(handler).not.toBeInstanceOf(Hono);
  expect(Object.hasOwn(handler, "request")).toBe(false);
  const invalid = () => {
    // @ts-expect-error the core handler has no Hono request entry
    handler.request("https://test/");
    // @ts-expect-error the core handler cannot be mounted as a Hono app
    new Hono().route("/api", handler);
    // @ts-expect-error the core handler requires context, including for nullable initial
    void handler.handle(new Request("https://test/posts/p1"), {});
    // @ts-expect-error initial token has the wrong type
    void handler.handle(new Request("https://test/posts/p1"), { context: { token: 1 } });
    // @ts-expect-error fork resolver must produce this handler's resolved context
    fork({ resolve: () => ({ tenantId: 1 }) }, () => ({
      execute: async () => ({ ok: true, data: null }),
      dispose() {},
    }));
  };
  expectTypeOf(invalid).toBeFunction();
  local[Symbol.dispose]();
});

test("empty input also requires an explicit context and exposes no Hono surface", async () => {
  const seen: Record<string, never>[] = [];
  const handler = createHttpHandler<Record<string, never>>(async (_request, initial) => {
    seen.push(initial);
    return Response.json({ ok: true });
  });
  await handler.handle(new Request("https://test/posts/p1"), { context: {} });
  expect(seen).toEqual([{}]);
  expect(Object.hasOwn(handler, "request")).toBe(false);
  const invalid = () => {
    // @ts-expect-error empty input is still supplied explicitly
    void handler.handle(new Request("https://test/posts/p1"), {});
  };
  expectTypeOf(invalid).toBeFunction();
});

test("testing forks do not promise user-added handler properties", () => {
  const handler = createTakibi()({ resolve: () => ({ tenantId: "test" }) })
    .defineCollections({})
    .actions({});
  const decorated = Object.assign(handler, { extra: () => 42 });
  const fork = getTestingFork(decorated);
  if (!fork) throw new Error("missing fork");
  const local = fork({}, () => ({ execute: async () => ({ ok: true, data: null }), dispose() {} }));
  expect(Object.hasOwn(local, "extra")).toBe(false);
  const invalid = () => {
    // @ts-expect-error a fork recreates the standard handler, not arbitrary extensions
    local.extra();
  };
  expectTypeOf(invalid).toBeFunction();
  local[Symbol.dispose]();
});
