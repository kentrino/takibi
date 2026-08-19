import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { and, createClient, createTakibi, fullAccess, none } from "../src/index";
import type { ActionDefinition, RegisteredAction, RuntimeActionDefinition } from "../src/action";
import { parseSchema } from "../src/schema";
import type {
  AccessContext,
  AccessPermission,
  ClientOf,
  CollectionDataInput,
  CollectionsOptions,
  JsonValue,
  TakibiHandler,
  TakibiResult,
  InferCollectionDoc,
  InferHandlerCollections,
} from "../src/index";
import { collectionActionsBrand, type StorageDriver } from "../src/types";

type User = { id: string; role: "admin" | "member" };
type AppCtx = { tenantId: string; user: User | null };

type LegacyActionInput<TAction> =
  TAction extends ActionDefinition<"collection" | "root", infer TSchema, JsonValue | void, never>
    ? TSchema extends StandardSchemaV1
      ? StandardSchemaV1.InferInput<TSchema>
      : never
    : never;

type LegacyActionOutput<TAction> =
  TAction extends ActionDefinition<
    "collection" | "root",
    StandardSchemaV1 | undefined,
    infer TOutput,
    never
  >
    ? TOutput extends void
      ? null
      : TOutput
    : JsonValue;

type LegacyActionClientMethod<TAction> =
  TAction extends ActionDefinition<"collection" | "root", infer TSchema, JsonValue | void, never>
    ? TSchema extends StandardSchemaV1
      ? undefined extends LegacyActionInput<TAction>
        ? (input?: LegacyActionInput<TAction>) => Promise<TakibiResult<LegacyActionOutput<TAction>>>
        : (input: LegacyActionInput<TAction>) => Promise<TakibiResult<LegacyActionOutput<TAction>>>
      : () => Promise<TakibiResult<LegacyActionOutput<TAction>>>
    : never;

type LegacyActionsClient<TActions> = {
  [K in keyof TActions]: LegacyActionClientMethod<TActions[K]>;
};

const createContext = createTakibi();

test("registered actions use the unknown-based runtime definition", () => {
  expectTypeOf<RegisteredAction["definition"]>().toEqualTypeOf<RuntimeActionDefinition>();
  expectTypeOf<Parameters<RuntimeActionDefinition["handler"]>[0]>().toEqualTypeOf<unknown>();
  expectTypeOf<Awaited<ReturnType<RuntimeActionDefinition["handler"]>>>().toEqualTypeOf<unknown>();
});

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
  expectTypeOf<CollectionsOptions>().not.toHaveProperty("tracer");

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

test("collection schemas require plain JSON object outputs", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });

  context.defineCollection({
    schema: z.object({
      nested: z.object({ label: z.string() }),
      values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
      optional: z.string().optional(),
    }),
    accessPolicy: fullAccess,
  });

  const checkInvalidSchemas = () => {
    context.defineCollection({
      // @ts-expect-error collection output must be an object
      schema: z.string(),
      accessPolicy: fullAccess,
    });
    context.defineCollection({
      // @ts-expect-error collection output must be an object, not an array
      schema: z.array(z.string()),
      accessPolicy: fullAccess,
    });
    context.defineCollection({
      // @ts-expect-error Date is not a JSON value
      schema: z.object({ created: z.date() }),
      accessPolicy: fullAccess,
    });
    context.defineCollection({
      // @ts-expect-error bigint is not a JSON value
      schema: z.object({ count: z.bigint() }),
      accessPolicy: fullAccess,
    });
    context.defineCollection({
      // @ts-expect-error a present undefined value is not a JSON value
      schema: z.object({ missing: z.undefined() }),
      accessPolicy: fullAccess,
    });
  };
  void checkInvalidSchemas;
});

test("collection migrations accept unknown intermediate data and constrain the final step", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const migrated = context.defineCollection({
    schema: z.object({ title: z.string(), published: z.boolean() }),
    accessPolicy: fullAccess,
    migrations: {
      base: 2,
      steps: [
        (data) => {
          expectTypeOf(data).toEqualTypeOf<unknown>();
          return { ...(data as { name: string }), title: (data as { name: string }).name };
        },
        (data) => {
          expectTypeOf(data).toEqualTypeOf<unknown>();
          return { ...(data as { title: string }), published: false };
        },
      ],
    },
  });
  type MigratedInput = CollectionDataInput<typeof migrated>;
  type MigratedDocument = InferCollectionDoc<typeof migrated>;
  expectTypeOf<MigratedInput>().not.toHaveProperty("_takibiVersion");
  expectTypeOf<MigratedDocument>().not.toHaveProperty("_takibiVersion");

  context.defineCollection({
    schema: z.object({ title: z.string(), published: z.boolean() }),
    accessPolicy: fullAccess,
    migrations: {
      // @ts-expect-error the last step must return the current schema input
      steps: [() => ({ title: "missing published" })],
    },
  });
  context.collections({
    invalid: {
      schema: z.object({ title: z.string(), published: z.boolean() }),
      accessPolicy: fullAccess,
      migrations: {
        // @ts-expect-error direct collection definitions constrain the final step too
        steps: [() => ({ title: "missing published" })],
      },
    },
  });

  const checkMarkerPrivacy = () => {
    const handler = context.collections({ migrated }, { memory: true });
    const client = createClient<typeof handler>("http://fire.test");
    // @ts-expect-error the internal marker is not accepted as document input
    void client.migrated.add({ title: "x", published: true, _takibiVersion: 4 });
    void client.migrated.list({
      // @ts-expect-error the internal marker is not queryable
      where: (query) => query._takibiVersion.eq(4),
    });
  };
  void checkMarkerPrivacy;
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
      promised: defineAction()
        .policy(fullAccess)
        .handler(() => Promise.resolve({ async: true as const })),
      voidOutput: defineAction()
        .policy(fullAccess)
        .handler(() => undefined),
    }),
  });
  const handler = context.collections({ posts }, { memory: true });
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.posts.transformed).parameter(0).toEqualTypeOf<string>();
  expectTypeOf(client.posts.transformed).returns.resolves.toEqualTypeOf<
    TakibiResult<{ length: number }>
  >();
  expectTypeOf(client.posts.coerced).parameter(0).toEqualTypeOf<unknown>();
  expectTypeOf(client.posts.promised).returns.resolves.toEqualTypeOf<
    TakibiResult<{ async: true }>
  >();
  expectTypeOf(client.posts.voidOutput).returns.resolves.toEqualTypeOf<TakibiResult<null>>();
  type CollectionActions = (typeof posts)[typeof collectionActionsBrand];
  expectTypeOf<Pick<typeof client.posts, keyof CollectionActions>>().toEqualTypeOf<
    LegacyActionsClient<CollectionActions>
  >();
  const checkCalls = () => {
    void client.posts.optional();
    void client.posts.optional("value");
    void client.posts.noInput();
    // @ts-expect-error no-input actions do not accept arguments
    void client.posts.noInput("value");
  };
  void checkCalls;
});

test("mixed collections() maps keep defineCollection action brands per entry", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const notes = {
    schema: z.object({ body: z.string() }),
    accessPolicy: fullAccess,
  };
  const posts = context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
    actions: (defineAction) => ({
      duplicate: defineAction()
        .policy(fullAccess)
        .handler(({ $collection }) => $collection.add({ title: "copy" })),
    }),
  });
  const handler = context.collections({ notes, posts }, { memory: true });
  const postsOnly = context.collections({ posts }, { memory: true });
  const client = createClient<typeof handler>("http://fire.test");
  const postsOnlyClient = createClient<typeof postsOnly>("http://fire.test");

  expectTypeOf(client.posts.duplicate).toEqualTypeOf(postsOnlyClient.posts.duplicate);
  expectTypeOf(client.notes).not.toHaveProperty("duplicate");
  expectTypeOf(client.notes.add).parameter(0).toEqualTypeOf<{ body: string }>();
  expectTypeOf(client.posts.add).parameter(0).toEqualTypeOf<{ title: string }>();
});

test("homogeneous collections() maps keep existing client inference", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const plainNotes = {
    schema: z.object({ body: z.string() }),
    accessPolicy: fullAccess,
  };
  const plainPosts = {
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
  };
  const brandedNotes = context.defineCollection({
    schema: z.object({ body: z.string() }),
    accessPolicy: fullAccess,
  });
  const brandedPosts = context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
    actions: (defineAction) => ({
      duplicate: defineAction()
        .policy(fullAccess)
        .handler(({ $collection }) => $collection.add({ title: "copy" })),
    }),
  });

  const allPlain = context.collections({ notes: plainNotes, posts: plainPosts }, { memory: true });
  const allBranded = context.collections(
    { notes: brandedNotes, posts: brandedPosts },
    { memory: true },
  );
  const plainClientFromHandler = createClient<typeof allPlain>("http://fire.test");
  const brandedClient = createClient<typeof allBranded>("http://fire.test");

  const postsOnly = context.collections({ posts: brandedPosts }, { memory: true });
  const postsOnlyClient = createClient<typeof postsOnly>("http://fire.test");

  expectTypeOf(plainClientFromHandler.notes.add).parameter(0).toEqualTypeOf<{ body: string }>();
  expectTypeOf(plainClientFromHandler.posts.add).parameter(0).toEqualTypeOf<{ title: string }>();
  expectTypeOf(plainClientFromHandler.notes).not.toHaveProperty("duplicate");
  expectTypeOf(plainClientFromHandler.posts).not.toHaveProperty("duplicate");
  expectTypeOf(brandedClient.notes.add).parameter(0).toEqualTypeOf<{ body: string }>();
  expectTypeOf(brandedClient.posts.duplicate).toEqualTypeOf(postsOnlyClient.posts.duplicate);
  expectTypeOf(brandedClient.notes).not.toHaveProperty("duplicate");
});

test("mixed collections() maps keep schema-bound policy and migration checks", () => {
  const takibi = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: { id: "u1", role: "member" } }),
  });
  const seeded = takibi.policy(z.object({ isSeed: z.boolean() }), ({ doc }) =>
    doc?.isSeed === true ? none : fullAccess,
  );
  const notes = {
    schema: z.object({ body: z.string() }),
    accessPolicy: fullAccess,
  };
  const items = takibi.defineCollection({
    schema: z.object({ name: z.string(), isSeed: z.boolean() }),
    accessPolicy: seeded,
  });

  takibi.collections({ notes, items });
  takibi.collections({
    notes,
    invalid: {
      schema: z.object({ title: z.string(), published: z.boolean() }),
      accessPolicy: fullAccess,
      migrations: {
        // @ts-expect-error mixed maps still constrain the final migration step
        steps: [() => ({ title: "missing published" })],
      },
    },
  });

  const checkMissingKeys = () => {
    takibi.collections({
      notes,
      items: {
        schema: z.object({ name: z.string() }),
        // @ts-expect-error mixed maps still require schema-bound policy keys
        accessPolicy: seeded,
      },
    });
  };
  void checkMissingKeys;
});

test("ClientOf projects action methods from inputSchema and handler", () => {
  const inputSchema = z.string().transform((value) => value.length);
  type StructuralHandler = {
    readonly "~takibi": {
      readonly collections: {};
      readonly actions: {
        readonly inspect: {
          readonly inputSchema: typeof inputSchema;
          readonly handler: (args: { input: number }) => Promise<{ positive: boolean }>;
        };
      };
    };
  };

  type StructuralClient = ClientOf<StructuralHandler>;
  expectTypeOf<StructuralClient["inspect"]>().toEqualTypeOf<
    (input: string) => Promise<TakibiResult<{ positive: boolean }>>
  >();
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

test("atomic actions preserve builder, handler, and client inference at every stage", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const Input = z.object({ title: z.string() });
  const posts = context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
    actions: (defineAction) => ({
      duplicate: defineAction()
        .atomic()
        .input(Input)
        .requires("create")
        .atomic()
        .policy(fullAccess)
        .atomic()
        .handler(({ input, ctx, collection, $collection }) => {
          expectTypeOf(input).toEqualTypeOf<{ title: string }>();
          expectTypeOf(ctx).toEqualTypeOf<AppCtx>();
          expectTypeOf(collection).toEqualTypeOf($collection);
          return { title: input.title, ok: true as const };
        }),
    }),
  });
  const base = context.collections({ posts }, { memory: true });
  const exportAll = base
    .defineAction()
    .input(Input)
    .atomic()
    .requires("list")
    .atomic()
    .policy(fullAccess)
    .atomic()
    .handler(({ input, ctx, collections, $collections }) => {
      expectTypeOf(input).toEqualTypeOf<{ title: string }>();
      expectTypeOf(ctx).toEqualTypeOf<AppCtx>();
      expectTypeOf(collections).toEqualTypeOf($collections);
      return { title: input.title, count: 0 };
    });
  const handler = base.actions({ exportAll });
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.exportAll).parameter(0).toEqualTypeOf<{ title: string }>();
  expectTypeOf(client.exportAll).returns.resolves.toEqualTypeOf<
    TakibiResult<{ title: string; count: number }>
  >();
  expectTypeOf(client.posts.duplicate).returns.resolves.toEqualTypeOf<
    TakibiResult<{ title: string; ok: true }>
  >();
  expectTypeOf(client.exportAll).not.toHaveProperty("atomic");
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
      accessPolicy({ permission, collection, user }) {
        expectTypeOf(permission).toEqualTypeOf<Exclude<AccessPermission, "invoke">>();
        expectTypeOf(collection).toEqualTypeOf<string>();
        expectTypeOf(user).toEqualTypeOf<User | null>();
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

test("inferred document uses collection names from the handler", () => {
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
  type Document = InferCollectionDoc<InferHandlerCollections<typeof handler>["posts"]>;
  expectTypeOf<Document["id"]>().toEqualTypeOf<string>();
  expectTypeOf<Document["title"]>().toEqualTypeOf<string>();
});

test("JsonValue includes arrays and inferred document ids are unconstrained strings", () => {
  expectTypeOf<string[]>().toExtend<JsonValue>();
  expectTypeOf<JsonValue[]>().toExtend<JsonValue>();
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
  type Document = InferCollectionDoc<InferHandlerCollections<typeof handler>["posts"]>;
  expectTypeOf<Document["id"]>().toEqualTypeOf<string>();
  const dotted: Document["id"] = "post.1:item";
  void dotted;
  expectTypeOf<keyof StorageDriver>().toEqualTypeOf<
    "delete" | "get" | "list" | "put" | "transaction"
  >();
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
  const staff = takibi.policy(({ user }) => {
    expectTypeOf(user).toEqualTypeOf<User | null>();
    return user ? fullAccess : none;
  });
  const ownerOnly = takibi.policy(z.object({ ownerId: z.string() }), ({ user, doc }) => {
    expectTypeOf(user).toEqualTypeOf<User | null>();
    return user?.id === doc?.ownerId ? fullAccess : none;
  });
  void staff;
  void ownerOnly;
  expectTypeOf(takibi).not.toHaveProperty("and");
  expectTypeOf(takibi).not.toHaveProperty("or");
});

test("schema-bound policy requires pick keys on the collection document", () => {
  const takibi = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: { id: "u1", role: "member" } }),
  });
  const staff = takibi.policy(({ user }) => (user ? fullAccess : none));
  const seeded = takibi.policy(z.object({ isSeed: z.boolean() }), ({ doc }) =>
    doc?.isSeed === true ? none : fullAccess,
  );

  takibi.collections({
    items: {
      schema: z.object({ name: z.string(), isSeed: z.boolean() }),
      accessPolicy: and(staff, seeded),
    },
  });
  takibi.collections({
    items: {
      schema: z.object({ name: z.string(), isSeed: z.boolean().optional() }),
      accessPolicy: seeded,
    },
  });
  takibi.defineCollection({
    schema: z.object({ name: z.string(), isSeed: z.boolean() }),
    accessPolicy: and(staff, seeded),
  });

  const checkMissingKeys = () => {
    takibi.collections({
      items: {
        schema: z.object({ name: z.string() }),
        // @ts-expect-error schema-bound policy keys must exist on the collection document
        accessPolicy: seeded,
      },
    });
    takibi.collections({
      items: {
        schema: z.object({ name: z.string() }),
        // @ts-expect-error and() preserves the schema-bound key constraint
        accessPolicy: and(staff, seeded),
      },
    });
    takibi.defineCollection({
      schema: z.object({ name: z.string() }),
      // @ts-expect-error defineCollection also rejects missing pick keys
      accessPolicy: seeded,
    });
    takibi.defineCollection({
      schema: z.object({ name: z.string() }),
      // @ts-expect-error defineCollection keeps the and() pick-schema constraint
      accessPolicy: and(staff, seeded),
    });
  };
  void checkMissingKeys;
});

test("AccessContext preserves application context keys without defining their vocabulary", () => {
  expectTypeOf<AccessContext<AppCtx>["user"]>().toEqualTypeOf<AppCtx["user"]>();
  expectTypeOf<AccessContext<AppCtx>["tenantId"]>().toEqualTypeOf<AppCtx["tenantId"]>();
  expectTypeOf<AccessContext<{ foo: string }>["foo"]>().toEqualTypeOf<string>();
});

test("execution context keys are application-owned across resolve, stub, and policy", () => {
  type Initial = { namespace: DurableObjectNamespace };
  type ClinicContext = {
    clinic: { slug: string };
    actor: { id: string };
  };
  const takibi = createTakibi<Initial>()({
    resolve: ({ context }): ClinicContext => {
      expectTypeOf(context.namespace).toEqualTypeOf<DurableObjectNamespace>();
      return { clinic: { slug: "clinic-a" }, actor: { id: "u1" } };
    },
    stub: ({ context, resolved }) => {
      expectTypeOf(context).toEqualTypeOf<Initial>();
      expectTypeOf(resolved).toEqualTypeOf<ClinicContext>();
      return context.namespace.get(context.namespace.idFromName(resolved.clinic.slug));
    },
  });
  takibi.collections({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy({ clinic, actor }) {
        expectTypeOf(clinic).toEqualTypeOf<{ slug: string }>();
        expectTypeOf(actor).toEqualTypeOf<{ id: string }>();
        return fullAccess;
      },
    },
  });
  expectTypeOf<AccessContext<ClinicContext>["clinic"]>().toEqualTypeOf<ClinicContext["clinic"]>();
  expectTypeOf<AccessContext<ClinicContext>["actor"]>().toEqualTypeOf<ClinicContext["actor"]>();
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

  type Definitions = InferHandlerCollections<typeof handler>;
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
  const byTitle: NonNullable<PostListOptions["where"]> = (query) => query.title.eq("hello");
  const byPublished: NonNullable<PostListOptions["where"]> = (query) => query.published.eq(true);
  const byMissing: NonNullable<PostListOptions["where"]> = (query) => {
    // @ts-expect-error unknown fields are not queryable
    return query.missing.eq("value");
  };
  void byTitle;
  void byPublished;
  void byMissing;
});
