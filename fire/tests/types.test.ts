import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { createClient, fire, none, write } from "../src/index";
import type {
  AccessPermission,
  CollectionDefinition,
  CollectionsOptions,
  DocumentId,
  FireResult,
  InferCollectionDoc,
} from "../src/index";

type User = { id: string; role: "admin" | "member" };
type AppCtx = { tenantId: string; user: User | null };

const createContext = fire.initialContext();

test("collection schemas type CRUD clients and trusted collections", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const handler = context.collections(
    {
      posts: {
        schema: z.object({ title: z.string(), published: z.boolean().default(false) }),
        accessPolicy: write,
      },
    },
    { memory: true },
  );
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.posts.add).parameter(0).toEqualTypeOf<{
    title: string;
    published?: boolean;
  }>();
  expectTypeOf(client.posts.add).parameter(1).toEqualTypeOf<{ id?: DocumentId } | undefined>();
  expectTypeOf(client.posts.update).parameter(1).toEqualTypeOf<{
    title?: string;
    published?: boolean;
  }>();
  expectTypeOf<Awaited<ReturnType<typeof client.posts.get>>>().toMatchTypeOf<
    FireResult<{
      id: string;
      title: string;
      published: boolean;
      createdAt: string;
      updatedAt: string;
    }>
  >();

  expectTypeOf(handler.$collections.posts.add).returns.resolves.toMatchTypeOf<{
    id: string;
    title: string;
    published: boolean;
  }>();
  expectTypeOf(handler.$collections.posts.get).returns.resolves.not.toHaveProperty("ok");
  expectTypeOf(handler).not.toHaveProperty("storage");
  expectTypeOf<CollectionsOptions>().toHaveProperty("memory");
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
    accessPolicy: write,
    actions: (defineAction) => ({
      transformed: defineAction()
        .input(z.string().transform((value) => value.length))
        .policy(write)
        .handler(({ input, ctx, collection, $collection }) => {
          expectTypeOf(input).toEqualTypeOf<number>();
          expectTypeOf(ctx.user).toEqualTypeOf<User | null>();
          expectTypeOf(collection).toEqualTypeOf($collection);
          return { length: input };
        }),
      optional: defineAction()
        .input(z.string().optional())
        .policy(write)
        .handler(({ input }) => ({ value: input ?? null })),
      coerced: defineAction()
        .input(z.coerce.number())
        .policy(write)
        .handler(({ input }) => {
          expectTypeOf(input).toEqualTypeOf<number>();
          return { value: input };
        }),
      noInput: defineAction()
        .policy(write)
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
    FireResult<{ length: number }>
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
      posts: { schema: z.object({ title: z.string() }), accessPolicy: write },
      notes: { schema: z.object({ body: z.string() }), accessPolicy: write },
    },
    { memory: true },
  );
  const exportAll = base
    .defineAction()
    .policy(write)
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

  expectTypeOf(client.exportAll).returns.resolves.toEqualTypeOf<FireResult<{ count: number }>>();
  expectTypeOf(client.posts).not.toHaveProperty("exportAll");
});

test("action builder requires policy before handler", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const base = context.collections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: write },
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
  builder.policy(write).handler(() => null);
});

test("action and collection collisions are type errors", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: write,
    // @ts-expect-error CRUD method names are reserved
    actions: (defineAction) => ({
      get: defineAction()
        .policy(write)
        .handler(() => null),
    }),
  });
  context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: write,
    // @ts-expect-error action names must be safe TypeScript identifiers
    actions: (defineAction) => ({
      "bad-name": defineAction()
        .policy(write)
        .handler(() => null),
    }),
  });

  const base = context.collections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: write },
  });
  const action = base
    .defineAction()
    .policy(write)
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
        accessPolicy: write,
      },
    });
    // @ts-expect-error numeric collection names are not public identifiers
    context.collections({
      1: {
        schema: z.object({ title: z.string() }),
        accessPolicy: write,
      },
    });
    // @ts-expect-error symbol collection names are not public identifiers
    context.collections({
      [symbolName]: {
        schema: z.object({ title: z.string() }),
        accessPolicy: write,
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

test("collection definition and inferred document use collection names", () => {
  const schema = z.object({ title: z.string() });
  type Definition = CollectionDefinition<typeof schema, AppCtx>;
  type Document = InferCollectionDoc<Definition>;
  expectTypeOf<Document["id"]>().toEqualTypeOf<DocumentId>();
  expectTypeOf<Document["title"]>().toEqualTypeOf<string>();
});
