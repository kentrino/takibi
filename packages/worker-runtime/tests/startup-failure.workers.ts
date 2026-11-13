import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { setWatchEnv } from "./watch-fixture";

// Startup runs under blockConcurrencyWhile, not in the constructor. When it
// fails (here: an unsupported stored layout version), the platform breaks the
// object's input gate and resets it: the request that activated it rejects
// with the startup error (as the constructor throw did before startup moved
// out of the constructor), and so does a later request. The object never
// serves on a database it could not open.

const request = () =>
  new Request("https://takibi.internal", {
    method: "POST",
    body: JSON.stringify({
      kind: "collection",
      collection: "other",
      operation: "get",
      id: "missing",
      context: { partition: "startup-failure" },
    }),
  });

test("a Durable Object whose storage layout cannot open rejects every request", async () => {
  setWatchEnv(env);
  const stub = env.TAKIBI_WATCH_TEST.get(env.TAKIBI_WATCH_TEST.idFromName("startup-failure"));
  // The first activation opens the layout; then the stored version is corrupted.
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE takibi_metadata SET value = ? WHERE key = ?",
      999,
      "layout_version",
    );
  });
  await evictDurableObject(stub);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fresh = env.TAKIBI_WATCH_TEST.get(env.TAKIBI_WATCH_TEST.idFromName("startup-failure"));
    await expect(fresh.fetch(request())).rejects.toThrow(
      /Unsupported Takibi storage layout version: 999/,
    );
  }
});
