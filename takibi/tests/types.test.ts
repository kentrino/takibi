import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createClient, createTakibi, fullAccess, none } from "../src/index";
import { parseSchema } from "../src/schema";
import type {
  AccessPermission,
  ClientOf,
  CollectionDefinition,
  CollectionsOptions,
  JsonValue,
  TakibiHandler,
  TakibiResult,
  InferCollectionDoc,
} from "../src/index";
import type { StorageDriver } from "../src/types";

type User = { id: string; role: "admin" | "member" };
type AppCtx = { tenantId: string; user: User | null };

const createContext = createTakibi();

test("collection schemas type CRUD clients without handler $collections", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const collections = {
    posts: {
      schema: z.object({ title: z.string(), published: z.boolean().default(false) }),
      accessPolicy: fullAccess,
    },
  };
  const handler = context.collections(collections, { memory: true });
  const durableHandler = context.collections(collections);
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.posts.add).parameter(0).toEqualTypeOf<{
    title: string;
    published?: boolean;
  }>();
  expectTypeOf(client.posts.add).parameter(1).toEqualTypeOf<{ id?: string } | undefined>();
  expectTypeOf(client.posts.update).parameter(1).toEqualTypeOf<{
    title?: string;
    published?: boolean;
  }>();
  expectTypeOf<Awaited<ReturnType<typeof client.posts.get>>>().toMatchTypeOf<
    TakibiResult<{
      id: string;
      title: string;
      published: boolean;
      createdAt: string;
      updatedAt: string;
    }>
  >();

  expectTypeOf(handler).not.toHaveProperty("$collections");
  expectTypeOf(durableHandler).not.toHaveProperty("$collections");
  expectTypeOf(handler).not.toHaveProperty("storage");
  expectTypeOf<CollectionsOptions>().toHaveProperty("memory");

  type DurableInstance = InstanceType<typeof handler.DurableObject>;
  expectTypeOf<DurableInstance>().toHaveProperty("$collections");
  expectTypeOf(durableHandler.DurableObject).instance.toHaveProperty("$collections");
  expectTypeOf<DurableInstance["$collections"]["posts"]["add"]>().returns.resolves.toMatchTypeOf<{
    id: string;
    title: string;
    published: boolean;
  }>();
  expectTypeOf<
    DurableInstance["$collections"]["posts"]["get"]
  >().returns.resolves.not.toHaveProperty("ok");

  const checkListQueries = () => {
    void client.posts.list({
      where: (query) =>
        query.and(
          query.createdAt.gte("2026-08-15T00:00:00.000Z"),
          query.not(query.published.eq(false)),
        ),
    });
    void client.posts.list({
      // @ts-expect-error unknown fields are not queryable
      where: (query) => query.missing.eq("value"),
    });
    void client.posts.list({
      // @ts-expect-error booleans only support equality
      where: (query) => query.published.gte(true),
    });
    void client.posts.list({
      // @ts-expect-error equality values follow the schema output type
      where: (query) => query.title.eq(42),
    });
  };
  void checkListQueries;
});

test("collection action input/output and scoped handler args are inferred", () => {
  const context = createContext({
    resolve: (): AppCtx => ({
      tenantId: "acme",
      user: { id: "u1", role: "member" },
    }),
  });
  const posts = context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
    actions: (defineAction) => ({
      transformed: defineAction()
        .input(z.string().transform((value) => value.length))
        .policy(fullAccess)
        .handler(({ input, ctx, collection, $collection }) => {
          expectTypeOf(input).toEqualTypeOf<number>();
          expectTypeOf(ctx.user).toEqualTypeOf<User | null>();
          expectTypeOf(collection).toEqualTypeOf($collection);
          return { length: input };
        }),
      optional: defineAction()
        .input(z.string().optional())
        .policy(fullAccess)
        .handler(({ input }) => ({ value: input ?? null })),
      coerced: defineAction()
        .input(z.coerce.number())
        .policy(fullAccess)
        .handler(({ input }) => {
          expectTypeOf(input).toEqualTypeOf<number>();
          return { value: input };
        }),
      noInput: defineAction()
        .policy(fullAccess)
        .handler(({ input }) => {
          expectTypeOf(input).toEqualTypeOf<undefined>();
          return { ok: true };
        }),
    }),
  });
  const handler = context.collections({ posts }, { memory: true });
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.posts.transformed).parameter(0).toEqualTypeOf<string>();
  expectTypeOf(client.posts.transformed).returns.resolves.toEqualTypeOf<
    TakibiResult<{ length: number }>
  >();
  expectTypeOf(client.posts.coerced).parameter(0).toEqualTypeOf<unknown>();
  const checkCalls = () => {
    void client.posts.optional();
    void client.posts.optional("value");
    void client.posts.noInput();
    // @ts-expect-error no-input actions do not accept arguments
    void client.posts.noInput("value");
  };
  void checkCalls;
});

test("root actions infer all collections and appear flat on the client", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const base = context.collections(
    {
      posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
      notes: { schema: z.object({ body: z.string() }), accessPolicy: fullAccess },
    },
    { memory: true },
  );
  const exportAll = base
    .defineAction()
    .policy(fullAccess)
    .handler(({ input, ctx, collections, $collections }) => {
      expectTypeOf(input).toEqualTypeOf<undefined>();
      expectTypeOf(ctx.user).toEqualTypeOf<User | null>();
      expectTypeOf(collections).toHaveProperty("posts");
      expectTypeOf(collections).toHaveProperty("notes");
      expectTypeOf(collections).toEqualTypeOf($collections);
      return { count: 0 };
    });
  const handler = base.actions({ exportAll });
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.exportAll).returns.resolves.toEqualTypeOf<TakibiResult<{ count: number }>>();
  expectTypeOf(client.posts).not.toHaveProperty("exportAll");
});

test("action builder requires policy before handler", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const base = context.collections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  const builder = base.defineAction();
  expectTypeOf(builder).not.toHaveProperty("handler");
  const checkMissingHandler = () => {
    // @ts-expect-error handler is unavailable until policy is set
    builder.handler(() => null);
    base
      .defineAction()
      // @ts-expect-error action inputs must be JSON-safe before schema parsing
      .input(z.date());
  };
  void checkMissingHandler;
  builder.policy(fullAccess).handler(() => null);
});

test("action gate callbacks infer ctx, scope, invocation, and permission", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: { id: "u1", role: "member" } }),
  });
  const base = context.collections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  base.defineAction().policy(({ ctx, scope, invocation, permission }) => {
    expectTypeOf(ctx.user).toEqualTypeOf<User | null>();
    expectTypeOf(scope).toEqualTypeOf<{ kind: "collection"; name: string } | { kind: "root" }>();
    expectTypeOf(invocation).toEqualTypeOf<{ kind: "action"; name: string }>();
    expectTypeOf(permission).toEqualTypeOf<AccessPermission>();
    return ctx.user ? fullAccess : none;
  });
});

test("action and collection collisions are type errors", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
    // @ts-expect-error CRUD method names are reserved
    actions: (defineAction) => ({
      get: defineAction()
        .policy(fullAccess)
        .handler(() => null),
    }),
  });
  context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
    // @ts-expect-error action names must be safe TypeScript identifiers
    actions: (defineAction) => ({
      "bad-name": defineAction()
        .policy(fullAccess)
        .handler(() => null),
    }),
  });

  const base = context.collections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  const action = base
    .defineAction()
    .policy(fullAccess)
    .handler(() => null);
  const symbolName = Symbol("action");
  const checkCollisions = () => {
    base.actions({
      // @ts-expect-error root action names cannot collide with collections
      posts: action,
    });
    base.actions({
      // @ts-expect-error reflective names are reserved
      // oxlint-disable-next-line unicorn/no-thenable -- verifies the API rejects thenables
      then: action,
    });
    base.actions({
      // @ts-expect-error action names must be safe TypeScript identifiers
      "bad-name": action,
    });
    base.actions({
      // @ts-expect-error numeric action names are not public identifiers
      1: action,
    });
    base.actions({
      // @ts-expect-error symbol action names are not public identifiers
      [symbolName]: action,
    });
    // @ts-expect-error collection names must be safe TypeScript identifiers
    context.collections({
      "bad-name": {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    });
    // @ts-expect-error numeric collection names are not public identifiers
    context.collections({
      1: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    });
    // @ts-expect-error symbol collection names are not public identifiers
    context.collections({
      [symbolName]: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    });
  };
  void checkCollisions;
});

test("policy context uses permission vocabulary", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  context.collections({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy({ permission, collection }) {
        expectTypeOf(permission).toEqualTypeOf<Exclude<AccessPermission, "invoke">>();
        expectTypeOf(collection).toEqualTypeOf<string>();
        return none;
      },
    },
  });
});

test("createTakibi binds TInitial then infers execution context from resolve", () => {
  type Initial = { token: string };
  const takibi = createTakibi<Initial>()({
    resolve: ({ context }) => {
      expectTypeOf(context).toEqualTypeOf<Initial>();
      return { tenantId: "acme" as const, user: { id: context.token } };
    },
  });
  const posts = takibi.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
    actions: (defineAction) => ({
      ping: defineAction()
        .policy(fullAccess)
        .handler(({ ctx }) => {
          expectTypeOf(ctx.user).toEqualTypeOf<{ id: string }>();
          return { ok: true as const };
        }),
    }),
  });
  void posts;
});

test("collection definition and inferred document use collection names", () => {
  const schema = z.object({ title: z.string() });
  type Definition = CollectionDefinition<typeof schema, AppCtx>;
  type Document = InferCollectionDoc<Definition>;
  expectTypeOf<Document["id"]>().toEqualTypeOf<string>();
  expectTypeOf<Document["title"]>().toEqualTypeOf<string>();
});

test("JsonValue includes arrays and inferred document ids are unconstrained strings", () => {
  expectTypeOf<string[]>().toExtend<JsonValue>();
  expectTypeOf<JsonValue[]>().toExtend<JsonValue>();
  const schema = z.object({ title: z.string() });
  type Document = InferCollectionDoc<CollectionDefinition<typeof schema, AppCtx>>;
  expectTypeOf<Document["id"]>().toEqualTypeOf<string>();
  const dotted: Document["id"] = "post.1:item";
  void dotted;
  expectTypeOf<keyof StorageDriver>().toEqualTypeOf<"delete" | "get" | "list" | "put">();
});

test("parseSchema infers Standard Schema output", () => {
  const schema = z.object({ title: z.string() });
  type Parsed = Awaited<ReturnType<typeof parseSchema<typeof schema>>>;
  expectTypeOf<Parsed>().toEqualTypeOf<StandardSchemaV1.InferOutput<typeof schema>>();
});

test("createTakibi policy helper keeps schema and context-only overloads", () => {
  const takibi = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: { id: "u1", role: "member" } }),
  });
  const staff = takibi.policy(({ user }) => (user ? fullAccess : none));
  const ownerOnly = takibi.policy(z.object({ ownerId: z.string() }), ({ user, doc }) =>
    user?.id === doc?.ownerId ? fullAccess : none,
  );
  void staff;
  void ownerOnly;
  expectTypeOf(takibi).not.toHaveProperty("and");
  expectTypeOf(takibi).not.toHaveProperty("or");
});

test("ClientOf matches createClient and rejects collection maps", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const handler = context.collections(
    {
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    },
    { memory: true },
  );

  type FromAlias = ClientOf<typeof handler>;
  type FromFactory = ReturnType<typeof createClient<typeof handler>>;
  expectTypeOf<FromAlias>().toEqualTypeOf<FromFactory>();
  expectTypeOf<ClientOf<TakibiHandler>>().toEqualTypeOf<
    ReturnType<typeof createClient<TakibiHandler>>
  >();

  type Definitions = { posts: CollectionDefinition };
  // @ts-expect-error collection maps are not a ClientOf type source
  type _FromMap = ClientOf<Definitions>;
});

test("list options can be projected from a public collection method", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const handler = context.collections(
    {
      posts: {
        schema: z.object({ title: z.string(), published: z.boolean() }),
        accessPolicy: fullAccess,
      },
    },
    { memory: true },
  );
  const client = createClient<typeof handler>("http://fire.test");
  type PostListOptions = NonNullable<Parameters<typeof client.posts.list>[0]>;
  expectTypeOf<PostListOptions>().toHaveProperty("limit");
  expectTypeOf<PostListOptions>().toHaveProperty("cursor");
  expectTypeOf<PostListOptions>().toHaveProperty("where");
  const checkWhere = (opts: PostListOptions) => {
    void opts.where?.((query) => query.title.eq("hello"));
    void opts.where?.((query) => query.published.eq(true));
    void opts.where?.((query) => {
      // @ts-expect-error unknown fields are not queryable
      return query.missing.eq("value");
    });
  };
  void checkWhere;
});
