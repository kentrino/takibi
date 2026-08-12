import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { createClient, defineResource, fire, ownedBy } from "../src/index";
import type {
  AccessAction,
  ContextConfig,
  DocumentId,
  DocumentMetadata,
  FireFailure,
  FireResult,
  InferResourceDoc,
  ResourcesOptions,
  WithId,
  WithMetadata,
} from "../src/index";

const createContext = fire.initialContext();

type User = { id: string; role: "admin" | "member" };
type AppCtx = { tenantId: string; user: User | null };

test("client methods are typed from resource schemas", () => {
  const Post = z.object({
    title: z.string(),
    body: z.string(),
  });

  const context = createContext({
    resolve: async ({ request }) => {
      void request;
      return { tenantId: "acme", user: { id: "u1", role: "member" } };
    },
  });

  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessPolicy({ user, action }) {
          if (user?.role === "admin") return true;
          if (action === "get" || action === "list") return true;
          return user != null;
        },
      },
    },
    { memory: true },
  );

  type Handler = typeof handler;
  const client = createClient<Handler>("http://localhost/foo");

  expectTypeOf(client.posts.add).parameter(0).toEqualTypeOf<{
    title: string;
    body: string;
  }>();
  expectTypeOf(client.posts.add).parameter(0).not.toMatchTypeOf<{ id?: string }>();
  expectTypeOf(client.posts.add).parameter(0).not.toMatchTypeOf<{ createdAt?: string }>();
  expectTypeOf(client.posts.add).parameter(0).not.toMatchTypeOf<{ updatedAt?: string }>();
  expectTypeOf(client.posts.add).parameter(1).toEqualTypeOf<{ id?: DocumentId } | undefined>();

  expectTypeOf(client.posts.set).parameter(1).toEqualTypeOf<{
    title: string;
    body: string;
  }>();
  expectTypeOf(client.posts.set).parameter(1).not.toMatchTypeOf<{ createdAt?: string }>();
  expectTypeOf(client.posts.update).parameter(1).toEqualTypeOf<{
    title?: string;
    body?: string;
  }>();
  expectTypeOf(client.posts.update).parameter(1).not.toMatchTypeOf<{ updatedAt?: string }>();

  type Got = Awaited<ReturnType<typeof client.posts.get>>;
  expectTypeOf<Got>().toMatchTypeOf<
    FireResult<{
      id: string;
      createdAt: string;
      updatedAt: string;
      title: string;
      body: string;
    }>
  >();

  type GotSuccess = Extract<Got, { ok: true }>;
  expectTypeOf<GotSuccess["data"]>().toMatchTypeOf<{
    id: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    body: string;
  }>();
  expectTypeOf<GotSuccess["data"]["id"]>().toEqualTypeOf<DocumentId>();
  expectTypeOf<GotSuccess["data"]["createdAt"]>().toEqualTypeOf<string>();
  expectTypeOf<GotSuccess["data"]["updatedAt"]>().toEqualTypeOf<string>();
  expectTypeOf<GotSuccess["data"]>().not.toMatchTypeOf<null>();

  type GotFailure = Extract<Got, { ok: false }>;
  expectTypeOf<GotFailure["error"]>().toMatchTypeOf<FireFailure>();

  expectTypeOf(handler.storage.posts.add).parameter(0).toEqualTypeOf<{
    title: string;
    body: string;
  }>();
  expectTypeOf(handler.storage.posts.add)
    .parameter(1)
    .toEqualTypeOf<{ id?: DocumentId } | undefined>();

  type StorageGot = Awaited<ReturnType<typeof handler.storage.posts.get>>;
  expectTypeOf<StorageGot>().toMatchTypeOf<
    FireResult<{
      id: string;
      createdAt: string;
      updatedAt: string;
      title: string;
      body: string;
    }>
  >();
  expectTypeOf<Extract<StorageGot, { ok: true }>["data"]>().not.toMatchTypeOf<null>();
});

test("resolve concrete user type flows into accessPolicy without cast", () => {
  createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: { id: "u1", role: "admin" } }),
  }).resources({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy({ user, action }) {
        expectTypeOf(user).toEqualTypeOf<User | null>();
        expectTypeOf(action).toEqualTypeOf<AccessAction>();
        if (user?.role === "admin") return true;
        if (action === "get" || action === "list") return true;
        return user != null;
      },
    },
  });
});

test("resource seed values are inferred from the schema input", () => {
  createContext({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
  }).resources({
    posts: {
      schema: z.object({
        title: z.string(),
        published: z.boolean().default(false),
      }),
      accessPolicy({ doc }) {
        if (doc) {
          expectTypeOf(doc.title).toEqualTypeOf<string>();
          expectTypeOf(doc.published).toEqualTypeOf<boolean>();
        }
        return true;
      },
      // @ts-expect-error seed values are checked against the schema input
      seed: () => ({
        welcome: {
          title: "Welcome",
        },
        invalid: {
          title: 123,
        },
      }),
    },
  });
});

test("execution context is inferred from resolve return without type args", () => {
  createContext({
    resolve: () => ({
      tenantId: "acme" as const,
      user: { id: "u1", role: "admin" as const },
    }),
  }).resources({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy({ user, tenantId }) {
        expectTypeOf(tenantId).toEqualTypeOf<"acme">();
        expectTypeOf(user).toEqualTypeOf<{ id: string; role: "admin" }>();
        return true;
      },
    },
  });
});

test("initialContext createContext rejects function shorthand and staged config keys", () => {
  // @ts-expect-error function shorthand removed — pass { resolve }
  createContext(({ tenantId, user }) => ({ tenantId, user }));

  // @ts-expect-error resolve is required; staged keys are gone
  createContext({});

  createContext({
    resolve: () => ({ tenantId: "acme", user: null }),
    // @ts-expect-error getUser removed
    getUser: async () => null,
  });

  createContext({
    resolve: () => ({ tenantId: "acme", user: null }),
    // @ts-expect-error getTenantId removed
    getTenantId: () => "acme",
  });

  createContext({
    resolve: () => ({ tenantId: "acme", user: null }),
    // @ts-expect-error context key is not an initialContext config option
    context: () => ({ tenantId: "acme", user: null }),
  });

  type OnlyResolve = ContextConfig<AppCtx>;
  expectTypeOf<OnlyResolve["resolve"]>().toEqualTypeOf<OnlyResolve["resolve"]>();
  expectTypeOf<OnlyResolve>().toHaveProperty("resolve");
  expectTypeOf<OnlyResolve>().not.toHaveProperty("getUser");
  expectTypeOf<OnlyResolve>().not.toHaveProperty("getTenantId");
  expectTypeOf<OnlyResolve>().not.toHaveProperty("bindings");
  expectTypeOf<OnlyResolve>().toHaveProperty("stub");
  expectTypeOf<ResourcesOptions>().toHaveProperty("memory");
  expectTypeOf<ResourcesOptions>().not.toHaveProperty("binding");
});

test("initial context is required on handle and typed into resolve / stub", () => {
  type Initial = {
    container: { get(name: "auth"): { id: string } };
    env: { TENANT_STORE: DurableObjectNamespace };
  };
  type NarrowCtx = { tenantId: "acme" | "beta"; user: User | null };

  const createContextWithInitial = fire.initialContext<Initial>();
  const context = createContextWithInitial({
    resolve: async ({ request, context: input }): Promise<NarrowCtx> => {
      void request;
      expectTypeOf(input.container.get("auth")).toEqualTypeOf<{ id: string }>();
      return {
        tenantId: "acme",
        user: { id: input.container.get("auth").id, role: "member" },
      };
    },
    stub: ({ context: input, tenantId }) => {
      expectTypeOf(tenantId).toEqualTypeOf<"acme" | "beta">();
      expectTypeOf(input.env.TENANT_STORE).toEqualTypeOf<DurableObjectNamespace>();
      const ns = input.env.TENANT_STORE;
      return ns.get(ns.idFromName(tenantId));
    },
  });

  const handler = context.resources(
    {
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy({ user }) {
          expectTypeOf(user).toEqualTypeOf<User | null>();
          return user != null;
        },
      },
    },
    { memory: true },
  );

  // @ts-expect-error initial context is required when TInitial has keys
  void handler.handle(new Request("http://fire.test/"), { prefix: "/rpc" });

  void handler.handle(new Request("http://fire.test/rpc"), {
    prefix: "/rpc",
    // @ts-expect-error wrong initial context shape
    context: { container: 1 },
  });

  void handler.handle(new Request("http://fire.test/rpc"), {
    prefix: "/rpc",
    context: {
      container: {
        get(name: "auth") {
          void name;
          return { id: "u1" };
        },
      },
      env: { TENANT_STORE: null as unknown as DurableObjectNamespace },
    },
  });

  void handler.handle(new Request("http://fire.test/rpc"), {
    prefix: "/rpc",
    context: {
      container: {
        get(name: "auth") {
          void name;
          return { id: "u1" };
        },
      },
      env: { TENANT_STORE: null as unknown as DurableObjectNamespace },
    },
    // @ts-expect-error env is not a handle option — put it on initial context
    env: { TENANT_STORE: null },
  });
});

test("empty initial context makes handle context optional", () => {
  const handler = createContext({
    resolve: () => ({ tenantId: "acme", user: null }),
  }).resources(
    {
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: () => true,
      },
    },
    { memory: true },
  );

  void handler.handle(new Request("http://fire.test/"), { prefix: "/" });
});

test("WithId replaces conflicting id types with DocumentId", () => {
  type Doc = WithId<{ id: number; title: string }>;
  expectTypeOf<Doc["id"]>().toEqualTypeOf<DocumentId>();
  expectTypeOf<Doc["title"]>().toEqualTypeOf<string>();
  expectTypeOf<Doc>().not.toMatchTypeOf<{ id: number }>();
});

test("WithMetadata requires DocumentMetadata and replaces conflicts", () => {
  type Doc = WithMetadata<{ id: number; createdAt: number; title: string }>;
  expectTypeOf<Doc>().toEqualTypeOf<DocumentMetadata & { title: string }>();
  expectTypeOf<Doc["id"]>().toEqualTypeOf<DocumentId>();
  expectTypeOf<Doc["createdAt"]>().toEqualTypeOf<string>();
  expectTypeOf<Doc["updatedAt"]>().toEqualTypeOf<string>();
  expectTypeOf<Doc>().not.toMatchTypeOf<{ createdAt: number }>();
});

test("accessPolicy receives typed doc / nextDoc from resource schema", () => {
  createContext({
    resolve: () => ({ tenantId: "acme", user: { id: "u1", role: "member" } }),
  }).resources({
    notes: defineResource({
      schema: z.object({
        ownerId: z.string(),
        title: z.string(),
      }),
      accessPolicy(ctx) {
        expectTypeOf(ctx.action).toEqualTypeOf<AccessAction>();
        if (ctx.doc) {
          expectTypeOf(ctx.doc.ownerId).toEqualTypeOf<string>();
          expectTypeOf(ctx.doc.title).toEqualTypeOf<string>();
          expectTypeOf(ctx.doc.id).toEqualTypeOf<DocumentId>();
          expectTypeOf(ctx.doc.createdAt).toEqualTypeOf<string>();
        }
        if (ctx.nextDoc) {
          expectTypeOf(ctx.nextDoc.ownerId).toEqualTypeOf<string>();
          expectTypeOf(ctx.nextDoc.id).toEqualTypeOf<DocumentId>();
        }
        return true;
      },
    }),
  });
});

test("ownedBy default ownerId and custom string field are assignable", () => {
  createContext({
    resolve: () => ({ tenantId: "acme", user: { id: "u1", role: "member" } }),
  }).resources({
    notes: defineResource({
      schema: z.object({
        ownerId: z.string(),
        title: z.string(),
      }),
      accessPolicy: ownedBy({
        subject: ({ user }) => (user as User | null)?.id,
        bypass: ({ user }) => (user as User | null)?.role === "admin",
      }),
    }),
    posts: defineResource({
      schema: z.object({
        authorId: z.string(),
        title: z.string(),
      }),
      accessPolicy: ownedBy({
        field: "authorId",
        subject: ({ user }) => (user as User | null)?.id,
      }),
    }),
  });
});

test("ownedBy rejects a field missing from the schema output", () => {
  const schema = z.object({
    title: z.string(),
  });
  type Def = import("../src/types").ResourceDefinition<typeof schema, AppCtx>;
  // @ts-expect-error ownedBy requires ownerId on the document
  const _policy: Def["accessPolicy"] = ownedBy({
    subject: ({ user }) => (user as User | null)?.id,
  });
  void _policy;
});

test("InferResourceDoc matches accessPolicy doc shape", () => {
  const Note = z.object({
    ownerId: z.string(),
    title: z.string(),
  });
  type NoteDef = { schema: typeof Note };
  type Doc = InferResourceDoc<NoteDef>;
  expectTypeOf<Doc["ownerId"]>().toEqualTypeOf<string>();
  expectTypeOf<Doc["title"]>().toEqualTypeOf<string>();
  expectTypeOf<Doc["id"]>().toEqualTypeOf<DocumentId>();
  expectTypeOf<Doc["createdAt"]>().toEqualTypeOf<string>();
  expectTypeOf<Doc["updatedAt"]>().toEqualTypeOf<string>();
});
