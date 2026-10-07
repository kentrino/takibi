import { type ClientOf } from "@takibi/client";
import { fullAccess } from "@takibi/policy";
import { createTakibi } from "@takibi/worker-runtime";
import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { type SqliteTestBackendOptions, withSqliteTestBackend } from "@takibi/testing";

type AppCtx = { tenantId: string; user: { id: string; role: "member" } | null };

test("withSqliteTestBackend keeps ClientOf collection action names", () => {
  const context = createTakibi()({
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
  const forked = withSqliteTestBackend(handler);
  const replaced = withSqliteTestBackend(handler, {
    resolve: (): AppCtx => ({ tenantId: "test", user: { id: "u1", role: "member" } }),
  });

  expectTypeOf<ClientOf<typeof forked>>().toEqualTypeOf<ClientOf<typeof handler>>();
  expectTypeOf<ClientOf<typeof replaced>>().toEqualTypeOf<ClientOf<typeof handler>>();
  expectTypeOf<ClientOf<typeof forked>["posts"]>().toHaveProperty("duplicate");

  const invalidOptions: SqliteTestBackendOptions<
    AppCtx,
    Record<string, never>,
    Record<string, never>
  > = {
    // @ts-expect-error resolve must return the original execution context
    resolve: () => ({ tenantId: "acme" }),
  };
  void invalidOptions;

  const reusableOptions: SqliteTestBackendOptions<
    AppCtx,
    { session: string },
    Record<never, never>
  > = {
    resolve: ({ context }): AppCtx => ({ tenantId: context.session, user: null }),
  };
  const reusable = withSqliteTestBackend(handler, reusableOptions);
  expectTypeOf<Parameters<typeof reusable.handle>[1]["context"]>().toEqualTypeOf<
    { session: string } | Record<string, never>
  >();
});

test("replacement resolvers define the SQLite handler input context", () => {
  type ProductionInitial = { env: { API_TOKEN: string } };
  const takibi = createTakibi<ProductionInitial>()({
    resolve: ({ context }): AppCtx => ({
      tenantId: context.env.API_TOKEN,
      user: null,
    }),
  });
  const handler = takibi.defineCollections({}).actions({});
  const inherited = withSqliteTestBackend(handler);
  const empty = withSqliteTestBackend(handler, {
    resolve: (): AppCtx => ({ tenantId: "test", user: null }),
  });
  const typed = withSqliteTestBackend(handler, {
    resolve: ({ context }: { request: Request; context: { session: string } }): AppCtx => ({
      tenantId: context.session,
      user: null,
    }),
  });

  expectTypeOf<Parameters<typeof empty.handle>[1]["context"]>().toEqualTypeOf<
    Record<string, never>
  >();
  expectTypeOf<
    Parameters<typeof inherited.handle>[1]["context"]
  >().toEqualTypeOf<ProductionInitial>();
  expectTypeOf<Parameters<typeof typed.handle>[1]["context"]>().toEqualTypeOf<{
    session: string;
  }>();
  expectTypeOf<(typeof typed)["~takibi"]["initial"]>().toEqualTypeOf<{
    session: string;
  }>();
  expectTypeOf<
    Parameters<typeof handler.handle>[1]["context"]
  >().toEqualTypeOf<ProductionInitial>();

  const invalidOutput = () =>
    withSqliteTestBackend(handler, {
      // @ts-expect-error replacement resolvers must preserve the production resolved context
      resolve: () => ({ tenantId: "test" }),
    });
  void invalidOutput;
});

test("non-empty services require a SQLite test backend services value", () => {
  const takibi = createTakibi()({
    resolve: (): AppCtx => ({ tenantId: "acme", user: null }),
    services: () => ({ flag: "x" }),
  });
  const app = takibi.defineCollections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  const handler = app.actions({});
  const checkBackend = () => {
    // @ts-expect-error SQLite test backend requires services when TServices is non-empty
    withSqliteTestBackend(handler);
  };
  void checkBackend;
  withSqliteTestBackend(handler, { services: { flag: "from-test" } });
  withSqliteTestBackend(handler, {
    resolve: () => ({ tenantId: "test", user: null }),
    services: { flag: "from-test" },
  });
  const missingServices = () => {
    // @ts-expect-error replacement resolvers do not make configured services optional
    withSqliteTestBackend(handler, {
      resolve: () => ({ tenantId: "test", user: null }),
    });
  };
  void missingServices;
});
