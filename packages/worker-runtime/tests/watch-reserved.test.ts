import { expect, it } from "vite-plus/test";
import { z } from "zod";
import { fullAccess } from "@takibi/policy";
import { createTakibi } from "../src/context";
it("reserves watch at collection action registration and in types", () => {
  const app = createTakibi()({ resolve: () => ({}) }).defineCollections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  expect(() => {
    const actions = app.posts.actions((define) => ({
      // @ts-expect-error watch is reserved for subscriptions
      watch: define()
        .detached()
        .policy(fullAccess)
        .handler(() => null),
    }));
    app.actions({ posts: actions });
  }).toThrow("reserved");
});
