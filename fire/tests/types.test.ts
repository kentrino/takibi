import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { ALL, READ, createClient, createContext } from "../src/index";
import type { ContextConfig, DocumentId, FireFailure, FireResult, WithId } from "../src/index";

type User = { id: string; role: "admin" | "member" };
type AppCtx = { tenantId: string; user: User | null };

test("client methods are typed from resource schemas", () => {
  const Post = z.object({
    title: z.string(),
    body: z.string(),
  });

  const context = createContext<AppCtx>({
    resolve: async ({ request }) => {
      void request;
      return { tenantId: "acme", user: { id: "u1", role: "member" } };
    },
  });

  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessControl({ user }) {
          return user ? ALL : READ;
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
  expectTypeOf(client.posts.add).parameter(1).toEqualTypeOf<{ id?: DocumentId } | undefined>();

  expectTypeOf(client.posts.set).parameter(1).toEqualTypeOf<{
    title: string;
    body: string;
  }>();
  expectTypeOf(client.posts.update).parameter(1).toEqualTypeOf<{
    title?: string;
    body?: string;
  }>();

  type Got = Awaited<ReturnType<typeof client.posts.get>>;
  expectTypeOf<Got>().toMatchTypeOf<
    FireResult<{
      id: string;
      title: string;
      body: string;
    }>
  >();

  type GotSuccess = Extract<Got, { ok: true }>;
  expectTypeOf<GotSuccess["data"]>().toMatchTypeOf<{
    id: string;
    title: string;
    body: string;
  }>();
  expectTypeOf<GotSuccess["data"]["id"]>().toEqualTypeOf<DocumentId>();
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
      title: string;
      body: string;
    }>
  >();
  expectTypeOf<Extract<StorageGot, { ok: true }>["data"]>().not.toMatchTypeOf<null>();
});

test("resolve concrete user type flows into accessControl without cast", () => {
  createContext<AppCtx>({
    resolve: () => ({ tenantId: "acme", user: { id: "u1", role: "admin" } }),
  }).resources({
    posts: {
      schema: z.object({ title: z.string() }),
      accessControl({ user }) {
        expectTypeOf(user).toEqualTypeOf<User | null>();
        if (user?.role === "admin") return ALL;
        return READ;
      },
    },
  });
});

test("createContext rejects function shorthand and staged config keys", () => {
  // @ts-expect-error function shorthand removed — pass { resolve }
  createContext<AppCtx>(({ tenantId, user }) => ({ tenantId, user }));

  // @ts-expect-error resolve is required; staged keys are gone
  createContext<AppCtx>({});

  createContext<AppCtx>({
    resolve: () => ({ tenantId: "acme", user: null }),
    // @ts-expect-error getUser removed
    getUser: async () => null,
  });

  createContext<AppCtx>({
    resolve: () => ({ tenantId: "acme", user: null }),
    // @ts-expect-error getTenantId removed
    getTenantId: () => "acme",
  });

  createContext<AppCtx>({
    resolve: () => ({ tenantId: "acme", user: null }),
    // @ts-expect-error context removed
    context: () => ({ tenantId: "acme", user: null }),
  });

  type OnlyResolve = ContextConfig<AppCtx>;
  expectTypeOf<OnlyResolve>().toEqualTypeOf<{ resolve: OnlyResolve["resolve"] }>();
  expectTypeOf<OnlyResolve>().not.toHaveProperty("getUser");
  expectTypeOf<OnlyResolve>().not.toHaveProperty("getTenantId");
  expectTypeOf<OnlyResolve>().not.toHaveProperty("context");
});

test("WithId replaces conflicting id types with DocumentId", () => {
  type Doc = WithId<{ id: number; title: string }>;
  expectTypeOf<Doc["id"]>().toEqualTypeOf<DocumentId>();
  expectTypeOf<Doc["title"]>().toEqualTypeOf<string>();
  expectTypeOf<Doc>().not.toMatchTypeOf<{ id: number }>();
});
