import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { ALL, READ, createClient, createContext } from "../src/index";
import type { FireFailure, FireResult } from "../src/index";

test("client methods are typed from resource schemas", () => {
  const Post = z.object({
    id: z.string().optional(),
    title: z.string(),
    body: z.string(),
  });

  const context = createContext<{ tenantId: string; user: { id: string } | null }>(
    ({ tenantId, user }) => ({
      tenantId,
      user: user as { id: string } | null,
    }),
  );

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

  expectTypeOf(client.posts.add).parameter(0).toMatchTypeOf<{
    title: string;
    body: string;
    id?: string;
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
  expectTypeOf<GotSuccess["data"]>().not.toMatchTypeOf<null>();

  type GotFailure = Extract<Got, { ok: false }>;
  expectTypeOf<GotFailure["error"]>().toMatchTypeOf<FireFailure>();

  expectTypeOf(handler.storage.posts.add).parameter(0).toMatchTypeOf<{
    title: string;
    body: string;
    id?: string;
  }>();

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
