import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createClient } from "@takibi/takibi/client";
import { and, createTakibi, fullAccess, none, UnauthorizedError } from "../src/index";
import type { RegisteredAction, RuntimeActionDefinition } from "../src/action";
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
import type { StorageDriver } from "../src/types";

type User = { id: string; role: "admin" | "member" };
type AppCtx = { tenantId: string; user: User | null };

const createContext = createTakibi();

test("registered actions use the unknown-based runtime definition", () => {
  expectTypeOf<RegisteredAction["definition"]>().toEqualTypeOf<RuntimeActionDefinition>();
  expectTypeOf<Parameters<RuntimeActionDefinition["handler"]>[0]>().toEqualTypeOf<unknown>();
  expectTypeOf<Awaited<ReturnType<RuntimeActionDefinition["handler"]>>>().toEqualTypeOf<unknown>();
  expectTypeOf<RuntimeActionDefinition["target"]>().toEqualTypeOf<"document" | "detached">();
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
  const handler = context.defineCollections(collections, { memory: true }).actions({});
  const durableHandler = context.defineCollections(collections).actions({});
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.posts.add).parameter(0).toEqualTypeOf<{
    title: string;
    published?: boolean;
  }>();
  expectTypeOf(client.posts.add).parameter(1).toEqualTypeOf<{ id?: string } | undefined>();
  expectTypeOf(client.posts.update).parameter(1).toMatchTypeOf<{
    title?: string;
    published?: boolean;
    rev?: number;
  }>();
  expectTypeOf(client.posts.set).parameter(1).toMatchTypeOf<{
    title: string;
    published?: boolean;
    rev?: number;
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
  expectTypeOf<
    DurableInstance["$collections"]["posts"]["listAll"]
  >().returns.resolves.toMatchTypeOf<
    {
      id: string;
      title: string;
      published: boolean;
      createdAt: string;
      updatedAt: string;
      rev: number;
    }[]
  >();

  const checkListQueries = () => {
    void client.posts.list({
      where: (query) =>
        query.and(
          query.createdAt.gte("2026-08-15T00:00:00.000Z"),
          query.not(query.published.eq(false)),
        ),
    });
    void client.posts.list({
      where: (query) => query.not(query.title.present()),
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
    void client.posts.listAll({
      where: (query) => query.published.eq(true),
    });
    void client.posts.listAll({
      // @ts-expect-error cursor is not a listAll option
      cursor: "page-2",
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
    context.defineCollection({
      // @ts-expect-error server-managed metadata cannot be a schema field
      schema: z.object({ id: z.string() }),
      accessPolicy: fullAccess,
    });
    context.defineCollection({
      // @ts-expect-error server-managed metadata cannot be a schema field
      schema: z.object({ createdAt: z.string() }),
      accessPolicy: fullAccess,
    });
    context.defineCollection({
      // @ts-expect-error server-managed metadata cannot be a schema field
      schema: z.object({ updatedAt: z.string() }),
      accessPolicy: fullAccess,
    });
    context.defineCollection({
      // @ts-expect-error schema version is reserved
      schema: z.object({ $schemaVersion: z.number() }),
      accessPolicy: fullAccess,
    });
    context.defineCollection({
      // @ts-expect-error revision is reserved
      schema: z.object({ rev: z.number() }),
      accessPolicy: fullAccess,
    });
    context.defineCollections({
      invalid: {
        // @ts-expect-error revision is reserved
        schema: z.object({ rev: z.number() }),
        accessPolicy: fullAccess,
      },
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
  expectTypeOf<MigratedInput>().not.toHaveProperty("$schemaVersion");
  expectTypeOf<MigratedDocument>().not.toHaveProperty("$schemaVersion");
  expectTypeOf<MigratedInput>().not.toHaveProperty("rev");
  expectTypeOf<MigratedDocument>().toHaveProperty("rev");

  context.defineCollection({
    schema: z.object({ title: z.string(), published: z.boolean() }),
    accessPolicy: fullAccess,
    migrations: {
      // @ts-expect-error the last step must return the current schema input
      steps: [() => ({ title: "missing published" })],
    },
  });
  context.defineCollections({
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
    const handler = context.defineCollections({ migrated }, { memory: true }).actions({});
    const client = createClient<typeof handler>("http://fire.test");
    // @ts-expect-error the internal marker is not accepted as document input
    void client.migrated.add({ title: "x", published: true, $schemaVersion: 4 });
    // @ts-expect-error revision is not accepted as document input
    void client.migrated.add({ title: "x", published: true, rev: 1 });
    void client.migrated.list({
      // @ts-expect-error the internal marker is not queryable
      where: (query) => query.$schemaVersion.eq(4),
    });
    void client.migrated.list({
      // @ts-expect-error revision is not queryable
      where: (query) => query.rev.eq(1),
    });
  };
  void checkMarkerPrivacy;
});

test("document and detached action handler args and client signatures are inferred", () => {
  const context = createContext({
    resolve: (): AppCtx => ({
      tenantId: "acme",
      user: { id: "u1", role: "member" },
    }),
  });
  const posts = context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
  });
  const app = context.defineCollections({ posts }, { memory: true });
  const postsActions = app.posts.actions((defineAction) => ({
    transformed: defineAction()
      .input(z.string().transform((value) => value.length))
      .policy(fullAccess)
      .handler(({ input, id, doc, ctx, collection, $collection, collections, $collections }) => {
        expectTypeOf(input).toEqualTypeOf<number>();
        expectTypeOf(id).toEqualTypeOf<string>();
        expectTypeOf(doc.title).toEqualTypeOf<string>();
        expectTypeOf(doc.rev).toEqualTypeOf<number>();
        expectTypeOf(ctx.user).toEqualTypeOf<User | null>();
        expectTypeOf(collection).toEqualTypeOf($collection);
        expectTypeOf(collections).toEqualTypeOf($collections);
        expectTypeOf(collections).toHaveProperty("posts");
        return { length: input };
      }),
    optional: defineAction()
      .input(z.object({ label: z.string() }).optional())
      .policy(fullAccess)
      .handler(({ input }) => ({ value: input?.label ?? null })),
    noInput: defineAction()
      .policy(fullAccess)
      .handler(({ input }) => {
        expectTypeOf(input).toEqualTypeOf<undefined>();
        return { ok: true };
      }),
    stats: defineAction()
      .detached()
      .input(z.object({ limit: z.number() }))
      .policy(fullAccess)
      .handler((args) => {
        expectTypeOf(args.input).toEqualTypeOf<{ limit: number }>();
        expectTypeOf(args).not.toHaveProperty("id");
        expectTypeOf(args).not.toHaveProperty("doc");
        expectTypeOf(args.collection).toEqualTypeOf(args.$collection);
        expectTypeOf(args.collections).toEqualTypeOf(args.$collections);
        return { count: args.input.limit };
      }),
    promised: defineAction()
      .detached()
      .policy(fullAccess)
      .handler(() => Promise.resolve({ async: true as const })),
    voidOutput: defineAction()
      .detached()
      .policy(fullAccess)
      .handler(() => undefined),
  }));
  const handler = app.actions({ posts: postsActions });
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.posts.transformed).parameters.toEqualTypeOf<[string, string]>();
  expectTypeOf(client.posts.transformed).returns.resolves.toEqualTypeOf<
    TakibiResult<{ length: number }>
  >();
  expectTypeOf(client.posts.noInput).parameters.toEqualTypeOf<[string]>();
  expectTypeOf(client.posts.stats).parameter(0).toEqualTypeOf<{ limit: number }>();
  expectTypeOf(client.posts.promised).returns.resolves.toEqualTypeOf<
    TakibiResult<{ async: true }>
  >();
  expectTypeOf(client.posts.voidOutput).returns.resolves.toEqualTypeOf<TakibiResult<null>>();

  const checkCalls = () => {
    void client.posts.optional("p1");
    void client.posts.optional("p1", { label: "x" });
    void client.posts.noInput("p1");
    // @ts-expect-error document actions require the target id first
    void client.posts.noInput();
    // @ts-expect-error no-input document actions accept only the id
    void client.posts.noInput("p1", "value");
    // @ts-expect-error detached actions do not take a document id
    void client.posts.stats("p1", { limit: 1 });
  };
  void checkCalls;

  const checkDetachedStringInput = () => {
    app.posts.actions((defineAction) => ({
      bad: defineAction()
        .detached()
        // @ts-expect-error detached collection actions cannot accept bare-string input
        .input(z.string())
        .policy(fullAccess)
        .handler(() => null),
      alsoBad: defineAction()
        .detached()
        // @ts-expect-error detached collection actions cannot accept string unions either
        .input(z.union([z.string(), z.object({ ok: z.boolean() })]))
        .policy(fullAccess)
        .handler(() => null),
    }));
  };
  void checkDetachedStringInput;
});

test("action maps attach methods per collection scope and enforce the scope brand", () => {
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
  });
  const app = context.defineCollections({ notes, posts }, { memory: true });
  const postsActions = app.posts.actions((defineAction) => ({
    duplicate: defineAction()
      .policy(fullAccess)
      .handler(({ doc, $collection }) => $collection.add({ title: doc.title })),
  }));
  const handler = app.actions({ posts: postsActions });
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.posts.duplicate).parameters.toEqualTypeOf<[string]>();
  expectTypeOf(client.notes).not.toHaveProperty("duplicate");
  expectTypeOf(client.notes.add).parameter(0).toEqualTypeOf<{ body: string }>();
  expectTypeOf(client.posts.add).parameter(0).toEqualTypeOf<{ title: string }>();

  const checkScopeBrand = () => {
    // @ts-expect-error scoped action maps cannot register under another collection
    app.actions({ notes: postsActions });
    // @ts-expect-error unknown scopes are rejected
    app.actions({ ghosts: postsActions });
  };
  void checkScopeBrand;
});

test("ClientOf projects action methods by scope and target", () => {
  const inputSchema = z.string().transform((value) => value.length);
  type StructuralHandler = {
    readonly "~takibi": {
      readonly collections: {
        readonly posts: {
          readonly schema: z.ZodObject<{ title: z.ZodString }>;
        };
      };
      readonly actions: {
        readonly $: {
          readonly inspect: {
            readonly inputSchema: typeof inputSchema;
            readonly handler: (args: { input: number }) => Promise<{ positive: boolean }>;
          };
        };
        readonly posts: {
          readonly touch: {
            readonly target: "document";
            readonly inputSchema: undefined;
            readonly handler: (args: { id: string }) => Promise<{ touched: true }>;
          };
        };
      };
    };
  };

  type StructuralClient = ClientOf<StructuralHandler>;
  expectTypeOf<StructuralClient["inspect"]>().toEqualTypeOf<
    (input: string) => Promise<TakibiResult<{ positive: boolean }>>
  >();
  expectTypeOf<StructuralClient["posts"]["touch"]>().toEqualTypeOf<
    (id: string) => Promise<TakibiResult<{ touched: true }>>
  >();
});

test("root actions infer all collections and appear flat on the client", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const app = context.defineCollections(
    {
      posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
      notes: { schema: z.object({ body: z.string() }), accessPolicy: fullAccess },
    },
    { memory: true },
  );
  const exportAll = app
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
  const handler = app.actions({ $: { exportAll } });
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.exportAll).returns.resolves.toEqualTypeOf<TakibiResult<{ count: number }>>();
  expectTypeOf(client.posts).not.toHaveProperty("exportAll");
});

test("atomic actions preserve builder, handler, and client inference at every stage", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const Input = z.object({ title: z.string() });
  const app = context.defineCollections(
    {
      posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
    },
    { memory: true },
  );
  const postsActions = app.posts.actions((defineAction) => ({
    duplicate: defineAction()
      .atomic()
      .input(Input)
      .requires("create")
      .atomic()
      .policy(fullAccess)
      .atomic()
      .handler(({ input, id, doc, ctx, collection, $collection }) => {
        expectTypeOf(input).toEqualTypeOf<{ title: string }>();
        expectTypeOf(id).toEqualTypeOf<string>();
        expectTypeOf(doc.title).toEqualTypeOf<string>();
        expectTypeOf(ctx).toEqualTypeOf<AppCtx>();
        expectTypeOf(collection).toEqualTypeOf($collection);
        return { title: input.title, ok: true as const };
      }),
  }));
  const exportAll = app
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
  const handler = app.actions({ $: { exportAll }, posts: postsActions });
  const client = createClient<typeof handler>("http://fire.test");

  expectTypeOf(client.exportAll).parameter(0).toEqualTypeOf<{ title: string }>();
  expectTypeOf(client.exportAll).returns.resolves.toEqualTypeOf<
    TakibiResult<{ title: string; count: number }>
  >();
  expectTypeOf(client.posts.duplicate).parameters.toEqualTypeOf<[string, { title: string }]>();
  expectTypeOf(client.posts.duplicate).returns.resolves.toEqualTypeOf<
    TakibiResult<{ title: string; ok: true }>
  >();
  expectTypeOf(client.exportAll).not.toHaveProperty("atomic");
});

test("action builder requires policy before handler", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const app = context.defineCollections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  const builder = app.defineAction();
  expectTypeOf(builder).not.toHaveProperty("handler");
  const checkMissingHandler = () => {
    // @ts-expect-error handler is unavailable until policy is set
    builder.handler(() => null);
    app
      .defineAction()
      // @ts-expect-error action inputs must be JSON-safe before schema parsing
      .input(z.date());
  };
  void checkMissingHandler;
  builder.policy(fullAccess).handler(() => null);
});

test("detached() is unavailable after input() and absent from root builders", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const app = context.defineCollections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  expectTypeOf(app.defineAction()).not.toHaveProperty("detached");
  const checkDetachedOrdering = () => {
    app.posts.actions((defineAction) => ({
      late: defineAction()
        .input(z.object({ title: z.string() }))
        // @ts-expect-error detached() must be called before input()
        .detached()
        .policy(fullAccess)
        .handler(() => null),
    }));
  };
  void checkDetachedOrdering;
});

test("use() refines handler and gate ctx; later chaining rejects use()", () => {
  type AuthedCtx = { tenantId: string; user: User };
  const requireUser = (ctx: AppCtx): AuthedCtx => {
    if (ctx.user == null) throw new UnauthorizedError("Sign in required");
    return { tenantId: ctx.tenantId, user: ctx.user };
  };
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const app = context.defineCollections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });

  app.posts.actions((defineAction) => ({
    accept: defineAction()
      .use(requireUser)
      .policy(({ ctx, target }) => {
        expectTypeOf(ctx).toEqualTypeOf<AuthedCtx>();
        expectTypeOf(ctx.user).toEqualTypeOf<User>();
        expectTypeOf(target.doc.title).toEqualTypeOf<string>();
        return ctx.user.role === "admin" ? fullAccess : none;
      })
      .handler(({ ctx, id }) => {
        expectTypeOf(ctx).toEqualTypeOf<AuthedCtx>();
        expectTypeOf(ctx.user.id).toEqualTypeOf<string>();
        return { id, by: ctx.user.id };
      }),
    publicPing: defineAction()
      .detached()
      .policy(({ ctx }) => {
        expectTypeOf(ctx.user).toEqualTypeOf<User | null>();
        return fullAccess;
      })
      .handler(({ ctx }) => {
        expectTypeOf(ctx.user).toEqualTypeOf<User | null>();
        return { ok: true as const };
      }),
  }));

  app
    .defineAction()
    .use(requireUser)
    .policy(({ ctx }) => {
      expectTypeOf(ctx).toEqualTypeOf<AuthedCtx>();
      return fullAccess;
    })
    .handler(({ ctx }) => {
      expectTypeOf(ctx.user.role).toEqualTypeOf<"admin" | "member">();
      return null;
    });

  const checkUseOrdering = () => {
    app.posts.actions((defineAction) => ({
      late: defineAction()
        .input(z.object({ title: z.string() }))
        // @ts-expect-error use() must be called immediately after defineAction()
        .use(requireUser)
        .policy(fullAccess)
        .handler(() => null),
    }));
    const afterPolicy = app.defineAction().policy(fullAccess);
    // @ts-expect-error use() is unavailable after policy()
    afterPolicy.use(requireUser);
  };
  void checkUseOrdering;
});

test("action gate callbacks infer ctx, scope, invocation, permission, and target", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: { id: "u1", role: "member" } }),
  });
  const app = context.defineCollections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  app.defineAction().policy(({ ctx, scope, invocation, permission }) => {
    expectTypeOf(ctx.user).toEqualTypeOf<User | null>();
    expectTypeOf(scope).toEqualTypeOf<{ kind: "collection"; name: string } | { kind: "root" }>();
    expectTypeOf(invocation).toEqualTypeOf<{ kind: "action"; name: string }>();
    expectTypeOf(permission).toEqualTypeOf<AccessPermission>();
    return ctx.user ? fullAccess : none;
  });
  app.posts.actions((defineAction) => ({
    touch: defineAction()
      .policy(({ ctx, target }) => {
        expectTypeOf(target.id).toEqualTypeOf<string>();
        expectTypeOf(target.doc.title).toEqualTypeOf<string>();
        return ctx.user ? fullAccess : none;
      })
      .handler(({ id }) => ({ touched: id })),
    detachedGate: defineAction()
      .detached()
      .policy((gate) => {
        expectTypeOf(gate.target).toEqualTypeOf<undefined | { id: string; doc: never }>();
        return gate.ctx.user ? fullAccess : none;
      })
      .handler(() => null),
  }));
});

test("action and collection collisions are type errors", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const app = context.defineCollections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  const checkCollectionActionNames = () => {
    app.posts.actions((defineAction) => ({
      // @ts-expect-error CRUD method names are reserved
      get: defineAction()
        .policy(fullAccess)
        .handler(() => null),
    }));
    app.posts.actions((defineAction) => ({
      // @ts-expect-error action names must be safe TypeScript identifiers
      "bad-name": defineAction()
        .policy(fullAccess)
        .handler(() => null),
    }));
  };
  void checkCollectionActionNames;

  const action = app
    .defineAction()
    .policy(fullAccess)
    .handler(() => null);
  const symbolName = Symbol("action");
  const checkCollisions = () => {
    app.actions({
      $: {
        // @ts-expect-error root action names cannot collide with collections
        posts: action,
      },
    });
    app.actions({
      $: {
        // @ts-expect-error reflective names are reserved
        // oxlint-disable-next-line unicorn/no-thenable -- verifies the API rejects thenables
        then: action,
      },
    });
    app.actions({
      $: {
        // @ts-expect-error action names must be safe TypeScript identifiers
        "bad-name": action,
      },
    });
    app.actions({
      $: {
        // @ts-expect-error numeric action names are not public identifiers
        1: action,
      },
    });
    app.actions({
      $: {
        // @ts-expect-error symbol action names are not public identifiers
        [symbolName]: action,
      },
    });
    // @ts-expect-error collection names must be safe TypeScript identifiers
    context.defineCollections({
      "bad-name": {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    });
    // @ts-expect-error numeric collection names are not public identifiers
    context.defineCollections({
      1: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    });
    // @ts-expect-error symbol collection names are not public identifiers
    context.defineCollections({
      [symbolName]: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    });
    // @ts-expect-error app definition members are reserved collection names
    context.defineCollections({
      actions: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    });
  };
  void checkCollisions;
});

test("policy context uses the widened permission vocabulary", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  context.defineCollections({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy({ permission, collection, user }) {
        expectTypeOf(permission).toEqualTypeOf<AccessPermission>();
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
  const app = takibi.defineCollections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  app.posts.actions((defineAction) => ({
    ping: defineAction()
      .detached()
      .policy(fullAccess)
      .handler(({ ctx }) => {
        expectTypeOf(ctx.user).toEqualTypeOf<{ id: string }>();
        return { ok: true as const };
      }),
  }));
});

test("inferred document uses collection names from the handler", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const handler = context
    .defineCollections(
      {
        posts: {
          schema: z.object({ title: z.string() }),
          accessPolicy: fullAccess,
        },
      },
      { memory: true },
    )
    .actions({});
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
  const handler = context
    .defineCollections(
      {
        posts: {
          schema: z.object({ title: z.string() }),
          accessPolicy: fullAccess,
        },
      },
      { memory: true },
    )
    .actions({});
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

  takibi.defineCollections({
    items: {
      schema: z.object({ name: z.string(), isSeed: z.boolean() }),
      accessPolicy: and(staff, seeded),
    },
  });
  takibi.defineCollections({
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
    takibi.defineCollections({
      items: {
        schema: z.object({ name: z.string() }),
        // @ts-expect-error schema-bound policy keys must exist on the collection document
        accessPolicy: seeded,
      },
    });
    takibi.defineCollections({
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

test("document action gates accept schema-bound policies; detached and root do not", () => {
  const takibi = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: { id: "u1", role: "member" } }),
  });
  const staff = takibi.policy(({ user }) => (user ? fullAccess : none));
  const seeded = takibi.policy(z.object({ isSeed: z.boolean() }), ({ doc }) =>
    doc?.isSeed === true ? none : fullAccess,
  );
  const itemSchema = z.object({ name: z.string(), isSeed: z.boolean() });

  const app = takibi.defineCollections({
    items: { schema: itemSchema, accessPolicy: seeded },
  });
  app.items.actions((defineAction) => ({
    duplicate: defineAction()
      .policy(seeded)
      .handler(() => null),
    publish: defineAction()
      .policy(and(staff, seeded))
      .handler(() => null),
  }));

  const checkRootRejectsSchemaBound = () => {
    app
      .defineAction()
      // @ts-expect-error root actions have no target document to bind
      .policy(seeded)
      .handler(() => null);
  };
  void checkRootRejectsSchemaBound;

  const checkDetachedRejectsSchemaBound = () => {
    app.items.actions((defineAction) => ({
      ping: defineAction()
        .detached()
        // @ts-expect-error detached actions have no target document to bind
        .policy(seeded)
        .handler(() => null),
    }));
  };
  void checkDetachedRejectsSchemaBound;

  const checkActionPickKeys = () => {
    const bare = takibi.defineCollections({
      items: { schema: z.object({ name: z.string() }), accessPolicy: fullAccess },
    });
    bare.items.actions((defineAction) => ({
      ping: defineAction()
        // @ts-expect-error schema-bound policy keys must exist on the collection document
        .policy(seeded)
        .handler(() => null),
    }));
  };
  void checkActionPickKeys;
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
  takibi.defineCollections({
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
  const handler = context
    .defineCollections(
      {
        posts: {
          schema: z.object({ title: z.string() }),
          accessPolicy: fullAccess,
        },
      },
      { memory: true },
    )
    .actions({});

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
  const handler = context
    .defineCollections(
      {
        posts: {
          schema: z.object({ title: z.string(), published: z.boolean() }),
          accessPolicy: fullAccess,
        },
      },
      { memory: true },
    )
    .actions({});
  const client = createClient<typeof handler>("http://fire.test");
  type PostListOptions = NonNullable<Parameters<typeof client.posts.list>[0]>;
  expectTypeOf<PostListOptions>().toHaveProperty("limit");
  expectTypeOf<PostListOptions>().toHaveProperty("cursor");
  expectTypeOf<PostListOptions>().toHaveProperty("where");
  type PostListAllOptions = NonNullable<Parameters<typeof client.posts.listAll>[0]>;
  expectTypeOf<PostListAllOptions>().toHaveProperty("where");
  expectTypeOf<PostListAllOptions>().toHaveProperty("pageSize");
  expectTypeOf<PostListAllOptions>().toHaveProperty("maxItems");
  expectTypeOf<PostListAllOptions>().not.toHaveProperty("limit");
  expectTypeOf<PostListAllOptions>().not.toHaveProperty("cursor");
  expectTypeOf<Awaited<ReturnType<typeof client.posts.listAll>>>().toMatchTypeOf<
    TakibiResult<{ id: string; title: string; published: boolean }[]>
  >();
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

test("with({ memory: true }) keeps ClientOf collection action names", () => {
  const context = createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  });
  const posts = context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
  });
  const app = context.defineCollections({ posts });
  const postsActions = app.posts.actions((defineAction) => ({
    duplicate: defineAction()
      .policy(fullAccess)
      .handler(() => ({ copied: true as const })),
  }));
  const handler = app.actions({ posts: postsActions });
  const forked = handler.with({ memory: true });
  const replaced = handler.with({
    memory: true,
    resolve: (): AppCtx => ({ tenantId: "test", user: { id: "u1", role: "member" } }),
  });

  expectTypeOf<ClientOf<typeof forked>>().toEqualTypeOf<ClientOf<typeof handler>>();
  expectTypeOf<ClientOf<typeof replaced>>().toEqualTypeOf<ClientOf<typeof handler>>();
  expectTypeOf<ClientOf<typeof forked>["posts"]>().toHaveProperty("duplicate");
  expectTypeOf<ClientOf<ReturnType<typeof handler.with>>["posts"]>().toHaveProperty("duplicate");

  handler.with({
    memory: true,
    // @ts-expect-error resolve must return the original execution context
    resolve: () => ({ tenantId: "acme" }),
  });
  // @ts-expect-error memory must be the literal true
  handler.with({ memory: false });
  // @ts-expect-error memory is required
  handler.with({ resolve: (): AppCtx => ({ tenantId: "acme", user: null }) });
});
