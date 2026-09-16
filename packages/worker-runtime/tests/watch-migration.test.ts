import { expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";
import { createDurableObjectStorage, observeCommits } from "@takibi/storage";
import { createMigratingStorage } from "../src/migrations";
import { fullAccess } from "@takibi/policy";
it("observes user writes outside migration storage without publishing lazy migration commits", async () => {
  const sqlite = createSqliteDurableObjectStorage();
  try {
    const raw = createDurableObjectStorage(sqlite);
    const legacy = {
      id: "old",
      title: "legacy",
      rev: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await raw.put("posts", legacy);
    const publish = vi.fn();
    const storage = observeCommits(
      createMigratingStorage(
        {
          posts: {
            schema: z.object({ title: z.string(), published: z.boolean() }),
            accessPolicy: fullAccess,
            migrations: {
              steps: [(data: unknown) => ({ ...(data as { title: string }), published: true })],
            },
          },
        },
        raw,
      ),
      publish,
    );
    expect(await storage.get("posts", "old")).toMatchObject({ published: true });
    expect(await raw.get("posts", "old")).toMatchObject({ published: true });
    expect(publish).not.toHaveBeenCalled();
    await storage.transaction(async (tx) => {
      await tx.put("posts", { ...legacy, published: false });
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(new Set(["posts"]));
  } finally {
    sqlite.close();
  }
});
