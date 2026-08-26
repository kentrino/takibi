import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { NotFoundError, StaleWriteError, TakibiError } from "../src/errors";
import { executeOperation } from "../src/executor";
import { fullAccess, none } from "../src/index";
import { createDurableObjectStorage, createMemoryStorage } from "../src/storage";
import { prepareSetDoc, storageAdd, storageSet, storageUpdate } from "../src/typed-storage";
import type { StoredDocument, WithMetadata } from "../src/types";
import { createSqliteDurableObjectStorage } from "./sqlite";

const TS = "2026-08-26T00:00:00.000Z";

const Post = z.object({ title: z.string().optional() });
const def = { schema: Post, accessPolicy: fullAccess };

function meta<T extends Record<string, unknown>>(doc: { id: string } & T): WithMetadata<T> {
  return { ...doc, createdAt: TS, updatedAt: TS, rev: 1 };
}

function rejections(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
}

// 1. Optimistic locking is check-then-write without a transaction: two writers
// holding the same rev interleave between `get` and `put`, and both succeed.
// One of them must fail with STALE_WRITE or the losing write is silently gone.
test("concurrent set with the same rev precondition must fail one writer with STALE_WRITE", async () => {
  const storage = createMemoryStorage();
  await storageAdd(def, storage, "posts", { title: "v1" }, { id: "p1" });

  const results = await Promise.allSettled([
    storageSet(def, storage, "posts", "p1", { title: "writer-a", rev: 1 }),
    storageSet(def, storage, "posts", "p1", { title: "writer-b", rev: 1 }),
  ]);

  const failed = rejections(results);
  expect(failed).toHaveLength(1);
  expect(failed[0]).toBeInstanceOf(StaleWriteError);
});

// 2. `commitAddDoc` does get-then-put without a transaction, so two concurrent
// adds with the same explicit id both pass the existence check and the second
// silently overwrites the first instead of failing with ALREADY_EXISTS.
test("concurrent add with the same id must fail one writer with ALREADY_EXISTS", async () => {
  const storage = createMemoryStorage();

  const results = await Promise.allSettled([
    storageAdd(def, storage, "posts", { title: "first" }, { id: "dup" }),
    storageAdd(def, storage, "posts", { title: "second" }, { id: "dup" }),
  ]);

  expect(rejections(results)).toHaveLength(1);
});

// 3. The memory driver's `get` hands out the live stored object (put clones,
// get does not), so callers mutating the result corrupt the store without a
// put. The DO driver re-parses JSON per read and is immune — parity is broken.
test("memory storage get returns an independent snapshot, not a live reference", async () => {
  const storage = createMemoryStorage();
  await storage.put("posts", meta({ id: "p1", title: "original", tags: ["a"] }) as StoredDocument);

  const first = await storage.get("posts", "p1");
  (first as { title: string }).title = "mutated";
  ((first as { tags: string[] }).tags).push("b");

  const second = await storage.get("posts", "p1");
  expect(second?.title).toBe("original");
  expect(second?.tags).toEqual(["a"]);
});

// 4. Memory sorts ids by UTF-16 code units, SQLite by UTF-8 bytes. For ids
// mixing U+E000..U+FFFF with astral characters the two orders diverge, so
// pagination order (and cursor `id > ?` seeks) differ between drivers.
test("memory and DO SQLite agree on list order for non-BMP ids", async () => {
  const memory = createMemoryStorage();
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());

  for (const id of ["x\uFFFF", "x\u{10000}"]) {
    const doc = meta({ id, title: "t" }) as StoredDocument;
    await memory.put("posts", doc);
    await durable.put("posts", doc);
  }

  const memoryPage = await memory.list("posts", undefined);
  const durablePage = await durable.list("posts", undefined);
  expect(durablePage.items.map((item) => item.id)).toEqual(
    memoryPage.items.map((item) => item.id),
  );
});

// 5. `encodeCursor` spreads every byte into `String.fromCharCode(...bytes)`.
// Ids are unbounded, so a paginated list over long ids blows the argument
// limit and the whole request dies with RangeError instead of returning a page.
test("list pagination survives long document ids", async () => {
  const storage = createMemoryStorage();
  await storage.put("posts", meta({ id: `a${"x".repeat(300_000)}`, title: "1" }) as StoredDocument);
  await storage.put("posts", meta({ id: `b${"x".repeat(300_000)}`, title: "2" }) as StoredDocument);

  const page = await storage.list("posts", { limit: 1 });
  expect(page.items).toHaveLength(1);
  expect(typeof page.nextCursor).toBe("string");
});

// 6. `asDataObject` lets arrays through (`typeof [] === "object"`), so a PATCH
// body like ["oops"] is spread into the merge as {"0": "oops"} and the update
// succeeds silently instead of rejecting a non-object input.
test("update rejects an array input instead of merging index keys", async () => {
  const storage = createMemoryStorage();
  await storageAdd(def, storage, "posts", { title: "keep" }, { id: "p1" });

  await expect(storageUpdate(def, storage, "posts", "p1", ["oops"])).rejects.toThrow();
});

// 7. `asDataObject` coerces any primitive input to {}, so a PUT body of 42
// replaces the whole document with the empty parse result — data is wiped by
// garbage input that should have been a validation error.
test("set rejects a primitive input instead of wiping the document", async () => {
  const storage = createMemoryStorage();
  await storageAdd(def, storage, "posts", { title: "keep" }, { id: "p1" });

  await expect(storageSet(def, storage, "posts", "p1", 42)).rejects.toThrow();

  const doc = await storage.get("posts", "p1");
  expect(doc?.title).toBe("keep");
});

// 8. rev is a float; at 2^53 the increment `rev + 1` rounds back to 2^53, so
// revisions stop advancing and every stale rev keeps matching the precondition
// — optimistic locking silently turns itself off.
test("set keeps revisions strictly increasing at the 2^53 boundary", async () => {
  const existing = meta({ id: "p1", title: "old" });
  (existing as { rev: number }).rev = Number.MAX_SAFE_INTEGER + 1;

  const next = await prepareSetDoc(def, "p1", { title: "new" }, existing);
  expect(next.rev as number).toBeGreaterThan(Number.MAX_SAFE_INTEGER + 1);
});

// 9. Concealment (denied doc-level access reads as NOT_FOUND) is bypassed:
// the rev precondition runs before the access policy, so a caller with zero
// permissions gets STALE_WRITE for missing docs but NOT_FOUND for existing
// ones — an existence-and-revision oracle.
test("revision precondition must not leak document existence to denied callers", async () => {
  const storage = createMemoryStorage();
  const collections = { posts: { schema: Post, accessPolicy: none } };
  await storage.put("posts", meta({ id: "hidden", title: "s" }) as StoredDocument);

  const setWithRev = (id: string) =>
    executeOperation(collections, storage, {}, {
      kind: "collection",
      collection: "posts",
      operation: "set",
      id,
      input: { title: "probe", rev: 1 },
    });

  // Existing doc: concealed as NOT_FOUND (works today).
  await expect(setWithRev("hidden")).rejects.toBeInstanceOf(NotFoundError);
  // Missing doc must be indistinguishable — but today it leaks STALE_WRITE.
  await expect(setWithRev("missing")).rejects.toBeInstanceOf(NotFoundError);
});

// 10. `assertJsonObject` recurses per nesting level with no depth limit, so a
// deeply nested document kills the isolate with RangeError instead of failing
// cleanly as INVALID_DOCUMENT.
test("storing a deeply nested document fails with a clean TakibiError, not a stack overflow", async () => {
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());
  let tree: unknown = null;
  for (let index = 0; index < 200_000; index += 1) tree = [tree];

  await expect(
    durable.put("posts", meta({ id: "deep", tree }) as StoredDocument),
  ).rejects.toBeInstanceOf(TakibiError);
});
