import { expect, test } from "vite-plus/test";
import { createDurableObjectStorage, createMemoryStorage } from "../src/storage";
import type { WithId } from "../src/types";
import { generateUlid, isUlid, resetUlidStateForTests } from "../src/ulid";

/** In-memory stand-in for DurableObjectStorage KV API used by createDurableObjectStorage. */
function createFakeDurableObjectStorage() {
  const store = new Map<string, WithId<Record<string, unknown>>>();

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: WithId<Record<string, unknown>>): Promise<void> {
      store.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
    async list<T>(options?: {
      prefix?: string;
      limit?: number;
      startAfter?: string;
    }): Promise<Map<string, T>> {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? Number.POSITIVE_INFINITY;
      const startAfter = options?.startAfter;
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .filter((k) => (startAfter === undefined ? true : k > startAfter))
        .slice(0, limit);
      const out = new Map<string, T>();
      for (const k of keys) out.set(k, structuredClone(store.get(k)) as T);
      return out;
    },
  } as unknown as DurableObjectStorage;
}

test("generateUlid produces valid 26-char Crockford Base32", () => {
  resetUlidStateForTests();
  const id = generateUlid();
  expect(id).toHaveLength(26);
  expect(isUlid(id)).toBe(true);
});

test("monotonic ULID: same-ms generation order matches lexicographic order", () => {
  resetUlidStateForTests();
  const now = 1_700_000_000_000;
  const ids = Array.from({ length: 64 }, () => generateUlid(now));
  for (const id of ids) expect(isUlid(id)).toBe(true);
  const sorted = [...ids].sort();
  expect(sorted).toEqual(ids);
});

test("memory and DO KV pagination agree on order, boundary, and nextCursor", async () => {
  const memory = createMemoryStorage();
  const durable = createDurableObjectStorage(createFakeDurableObjectStorage());

  const docs = [
    { id: "c", title: "C" },
    { id: "a", title: "A" },
    { id: "b", title: "B" },
    { id: "d", title: "D" },
    { id: "e", title: "E" },
  ];

  for (const doc of docs) {
    await memory.put("posts", doc);
    await durable.put("posts", doc);
  }

  // Distinct resources with the same id must not collide on DO keys.
  await durable.put("comments", { id: "a", body: "x" });
  expect(await durable.get("posts", "a")).toEqual({ id: "a", title: "A" });
  expect(await durable.get("comments", "a")).toEqual({ id: "a", body: "x" });

  const page1Memory = await memory.list("posts", { limit: 2 });
  const page1Durable = await durable.list("posts", { limit: 2 });
  expect(page1Memory).toEqual(page1Durable);
  expect(page1Memory.items.map((d) => d.id)).toEqual(["a", "b"]);
  expect(page1Memory.nextCursor).toBe("b");

  const page2Memory = await memory.list("posts", { limit: 2, cursor: page1Memory.nextCursor });
  const page2Durable = await durable.list("posts", { limit: 2, cursor: page1Durable.nextCursor });
  expect(page2Memory).toEqual(page2Durable);
  expect(page2Memory.items.map((d) => d.id)).toEqual(["c", "d"]);
  expect(page2Memory.nextCursor).toBe("d");

  const page3Memory = await memory.list("posts", { limit: 2, cursor: page2Memory.nextCursor });
  const page3Durable = await durable.list("posts", { limit: 2, cursor: page2Durable.nextCursor });
  expect(page3Memory).toEqual(page3Durable);
  expect(page3Memory.items.map((d) => d.id)).toEqual(["e"]);
  expect(page3Memory.nextCursor).toBeUndefined();

  // Missing cursor seeks past that key (startAfter), not rewind to the start.
  const afterMissingMemory = await memory.list("posts", { limit: 10, cursor: "a0" });
  const afterMissingDurable = await durable.list("posts", { limit: 10, cursor: "a0" });
  expect(afterMissingMemory).toEqual(afterMissingDurable);
  expect(afterMissingMemory.items.map((d) => d.id)).toEqual(["b", "c", "d", "e"]);
});

test("DO get reads only fire:${resource}:${id}", async () => {
  const fake = createFakeDurableObjectStorage();
  const durable = createDurableObjectStorage(fake);
  await durable.put("posts", { id: "p1", title: "hi" });
  await fake.put("fire:posts:p2", { id: "p2", title: "other" });
  await fake.put("unrelated", { id: "x", title: "nope" });

  expect(await durable.get("posts", "p1")).toEqual({ id: "p1", title: "hi" });
  expect(await durable.get("posts", "missing")).toBeNull();
});
