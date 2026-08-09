import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { ALL, READ, createClient, createContext } from "../src/index";

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
  expectTypeOf<Got>().toMatchTypeOf<{
    id: string;
    title: string;
    body: string;
  } | null>();

  expectTypeOf(handler.storage.posts.add).parameter(0).toMatchTypeOf<{
    title: string;
    body: string;
    id?: string;
  }>();
});
