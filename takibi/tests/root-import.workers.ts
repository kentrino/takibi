import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess } from "../src/index";

test("root import starts without Node compatibility on an older date", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
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

  const response = await handler.request("https://takibi.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "compatible" }),
  });

  expect(response.status).toBe(200);
});
