import { type ClientOf } from "@takibi/client";
import { fullAccess } from "@takibi/policy";
import { createTakibi } from "@takibi/worker-runtime";
import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { type SqliteTestBackendOptions, withSqliteTestBackend } from "../src";

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
});
