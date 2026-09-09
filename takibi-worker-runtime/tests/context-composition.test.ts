import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { fullAccess } from "@takibi/takibi-policy";
import { createTakibi, readTakibiBrand, TAKIBI_BRAND, type LogEvent } from "../src";
import { getTestingFork, type TestingExecutorFactory } from "../src/testing-bridge.server";
import { Hono } from "hono";
import { createHttpHandler } from "../src/context/http-handler";
import { createContext } from "../src/context/definition";
import { ownStringEntries } from "../src/context/own-entries";

// The public facade is the only dynamic type boundary. These tests cover the
// relationships that must survive it, including arguments to stored callbacks.
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
    prefix?: string;
    context: Initial;
  }>();
  expectTypeOf(handler.DurableObject).constructorParameters.toEqualTypeOf<
    [DurableObjectState, Env]
  >();
  expectTypeOf(readTakibiBrand(handler).actions.posts).toEqualTypeOf<typeof actions>();
  const invalid = () => {
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
    services: () => ({ name: "production" }),
    logger: { log: (event) => originalEvents.push(event) },
  })
    .defineCollections({
      posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
    })
    .actions({});
  const fork = getTestingFork(source);
  if (!fork) throw new Error("testing fork is missing");
  const allocations: Parameters<TestingExecutorFactory>[0][] = [];
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
  expect(allocations[0].registry).not.toBe(allocations[1].registry);
  expect(allocations[0].services).toBeNull();
  expect(allocations[1].services).toEqual({ name: "right" });
  if (!(left instanceof Hono) || !(right instanceof Hono)) throw new Error("not a Hono app");
  const response = await left.request("https://test/posts/p1");
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
  const handler = createHttpHandler(async (_request, initial) => {
    initialValues.push(initial);
    return Response.json({ ok: true });
  });
  expect(await handler.handle(new Request("https://test/posts/p1"), { prefix: "/api" })).toEqual({
    matched: false,
  });
  expect(initialValues).toEqual([]);
  await handler.handle(new Request("https://test/posts/p1"), { context: null });
  await handler.handle(new Request("https://test/posts/p1"), {});
  expect(initialValues).toEqual([null, {}]);
});
