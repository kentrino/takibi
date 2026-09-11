import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { NotFoundError, TakibiError } from "../src/errors";
import { executeOperation } from "../src/executor";
import { fullAccess, none, write } from "../src/index";
import { createDurableObjectStorage } from "../src/storage";
import { createSqliteDurableObjectStorage } from "@takibi/takibi-testing/sqlite-storage";
import { prepareSetDoc, storageAdd, storageSet, storageUpdate } from "../src/typed-storage";
import type { StoredDocument, WithMetadata } from "../src/types";

const TS = "2026-08-26T00:00:00.000Z";

const Post = z.object({ title: z.string().optional() });
const def = { schema: Post, accessPolicy: fullAccess };

function meta<T extends Record<string, unknown>>(doc: { id: string } & T): WithMetadata<T> {
  return { ...doc, createdAt: TS, updatedAt: TS, rev: 1 };
}

function createStorage() {
  return createDurableObjectStorage(createSqliteDurableObjectStorage());
}

// SQLite orders text keys by their UTF-8 byte representation.
test("SQLite list has stable order for non-BMP ids", async () => {
  const storage = createStorage();
  for (const id of ["x\uFFFF", "x\u{10000}"]) {
    const doc = meta({ id, title: "t" }) as StoredDocument;
    await storage.put("posts", doc);
  }

  const page = await storage.list("posts", undefined);
  expect(page.items.map((item) => item.id)).toEqual(["x\uFFFF", "x\u{10000}"]);
});

// `encodeCursor` spreads every byte into `String.fromCharCode(...bytes)`.
// Ids are unbounded, so a paginated list over long ids blows the argument
// limit and the whole request dies with RangeError instead of returning a page.
test("list pagination survives long document ids", async () => {
  const storage = createStorage();
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
  const storage = createStorage();
  await storageAdd(def, storage, "posts", { title: "keep" }, { id: "p1" });

  await expect(storageUpdate(def, storage, "posts", "p1", ["oops"])).rejects.toThrow();
});

// 7. `asDataObject` coerces any primitive input to {}, so a PUT body of 42
// replaces the whole document with the empty parse result — data is wiped by
// garbage input that should have been a validation error.
test("set rejects a primitive input instead of wiping the document", async () => {
  const storage = createStorage();
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
  (existing as unknown as { rev: number }).rev = Number.MAX_SAFE_INTEGER + 1;

  const next = await prepareSetDoc(def, "p1", { title: "new" }, existing);
  expect(next.rev as number).toBeGreaterThan(Number.MAX_SAFE_INTEGER + 1);
});

// 9. Concealment (denied doc-level access reads as NOT_FOUND) is bypassed:
// the rev precondition runs before the access policy, so a caller with zero
// permissions gets STALE_WRITE for missing docs but NOT_FOUND for existing
// ones — an existence-and-revision oracle.
test("revision precondition must not leak document existence to denied callers", async () => {
  const storage = createStorage();
  const collections = { posts: { schema: Post, accessPolicy: none } };
  await storage.put("posts", meta({ id: "hidden", title: "s" }) as StoredDocument);

  const setWithRev = (id: string) =>
    executeOperation(
      collections,
      storage,
      {},
      {
        kind: "collection",
        collection: "posts",
        operation: "set",
        id,
        input: { title: "probe", rev: 1 },
      },
    );

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

// 11. `update` collates the grant against `update` only, then returns the full
// merged document. The permission model separates read from write — the
// exported `write` grant is create / update / delete with no get / list — so a
// caller whose `get` is concealed as NOT_FOUND still reads every field by
// PATCHing an empty body. The read needs no schema knowledge and leaves the
// document content unchanged, so it is invisible to the owner.
test("update must not return document fields to a caller denied get", async () => {
  const storage = createStorage();
  const Note = z.object({ title: z.string(), ssn: z.string() });
  const collections = { notes: { schema: Note, accessPolicy: write } };
  await storage.put("notes", meta({ id: "n1", title: "t", ssn: "123-45-6789" }) as StoredDocument);

  const run = (operation: "get" | "update") =>
    executeOperation(
      collections,
      storage,
      {},
      {
        kind: "collection",
        collection: "notes",
        operation,
        id: "n1",
        ...(operation === "update" ? { input: {} } : {}),
      },
    );

  await expect(run("get")).rejects.toBeInstanceOf(NotFoundError);
  expect(await run("update")).not.toHaveProperty("ssn");
});

// 12. Concealment is bypassed again: `update` validates the merged document
// before the access policy. A denied caller sending a type-wrong patch gets
// VALIDATION for an existing id and NOT_FOUND for a missing one — an existence
// oracle that needs no valid payload and no `rev`.
test("schema validation must not leak document existence to denied callers", async () => {
  const storage = createStorage();
  const collections = { posts: { schema: Post, accessPolicy: none } };
  await storage.put("posts", meta({ id: "hidden", title: "s" }) as StoredDocument);

  const updateInvalid = (id: string) =>
    executeOperation(
      collections,
      storage,
      {},
      {
        kind: "collection",
        collection: "posts",
        operation: "update",
        id,
        input: { title: 12345 },
      },
    );

  await expect(updateInvalid("hidden")).rejects.toBeInstanceOf(NotFoundError);
  await expect(updateInvalid("missing")).rejects.toBeInstanceOf(NotFoundError);
});
