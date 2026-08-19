import { expect, test } from "vite-plus/test";
import { BadRequestError } from "../src/errors";
import { createDurableObjectStorage, createMemoryStorage } from "../src/storage";
import type { QueryExpr, WithMetadata } from "../src/types";
import { generateUlid, isUlid, resetUlidStateForTests } from "../src/ulid";

const TS = "2026-08-09T14:12:00.000Z";

function meta<T extends Record<string, unknown>>(doc: { id: string } & T): WithMetadata<T> {
  return { ...doc, createdAt: TS, updatedAt: TS };
}

function decodeCursor(token: string): Record<string, unknown> {
  const base64 = token.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function encodeCursor(cursor: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** In-memory stand-in for DurableObjectStorage KV API used by createDurableObjectStorage. */
function createFakeDurableObjectStorage(
  onList?: (
    options: { prefix?: string; limit?: number; startAfter?: string },
    result: Map<string, WithMetadata<Record<string, unknown>>>,
  ) => void,
) {
  const store = new Map<string, WithMetadata<Record<string, unknown>>>();

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: WithMetadata<Record<string, unknown>>): Promise<void> {
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
      onList?.(options ?? {}, out as Map<string, WithMetadata<Record<string, unknown>>>);
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
    meta({ id: "c", title: "C" }),
    meta({ id: "a", title: "A" }),
    meta({ id: "b", title: "B" }),
    meta({ id: "d", title: "D" }),
    meta({ id: "e", title: "E" }),
  ];

  for (const doc of docs) {
    await memory.put("posts", doc);
    await durable.put("posts", doc);
  }

  // Distinct resources with the same id must not collide on DO keys.
  await durable.put("comments", meta({ id: "a", body: "x" }));
  expect(await durable.get("posts", "a")).toEqual(meta({ id: "a", title: "A" }));
  expect(await durable.get("comments", "a")).toEqual(meta({ id: "a", body: "x" }));

  const page1Memory = await memory.list("posts", { limit: 2 });
  const page1Durable = await durable.list("posts", { limit: 2 });
  expect(page1Memory).toEqual(page1Durable);
  expect(page1Memory.items.map((d) => d.id)).toEqual(["a", "b"]);
  expect(decodeCursor(page1Memory.nextCursor!)).toEqual({
    v: 2,
    collection: "posts",
    where: null,
    id: "b",
  });

  const page2Memory = await memory.list("posts", { limit: 2, cursor: page1Memory.nextCursor });
  const page2Durable = await durable.list("posts", { limit: 2, cursor: page1Durable.nextCursor });
  expect(page2Memory).toEqual(page2Durable);
  expect(page2Memory.items.map((d) => d.id)).toEqual(["c", "d"]);
  expect(decodeCursor(page2Memory.nextCursor!)).toMatchObject({ id: "d" });

  const page3Memory = await memory.list("posts", { limit: 2, cursor: page2Memory.nextCursor });
  const page3Durable = await durable.list("posts", { limit: 2, cursor: page2Durable.nextCursor });
  expect(page3Memory).toEqual(page3Durable);
  expect(page3Memory.items.map((d) => d.id)).toEqual(["e"]);
  expect(page3Memory.nextCursor).toBeUndefined();

  // Missing cursor seeks past that key (startAfter), not rewind to the start.
  const missingCursor = encodeCursor({
    ...decodeCursor(page1Memory.nextCursor!),
    id: "a0",
  });
  const afterMissingMemory = await memory.list("posts", { limit: 10, cursor: missingCursor });
  const afterMissingDurable = await durable.list("posts", { limit: 10, cursor: missingCursor });
  expect(afterMissingMemory).toEqual(afterMissingDurable);
  expect(afterMissingMemory.items.map((d) => d.id)).toEqual(["b", "c", "d", "e"]);

  await expect(memory.list("posts", { cursor: "b" })).rejects.toBeInstanceOf(BadRequestError);
});

test("memory and DO filter before limit with query-bound cursors", async () => {
  const memory = createMemoryStorage();
  const durable = createDurableObjectStorage(createFakeDurableObjectStorage());
  const docs = [
    meta({ id: "a", ownerId: "u2", score: 30 }),
    meta({ id: "b", ownerId: "u1", score: 10 }),
    meta({ id: "c", ownerId: "u2", score: 20 }),
    meta({ id: "d", ownerId: "u1", score: 20 }),
    meta({ id: "e", ownerId: "u1", score: 30 }),
  ];
  for (const doc of docs) {
    await memory.put("posts", doc);
    await durable.put("posts", doc);
  }

  const where: QueryExpr = { field: "ownerId", op: "eq", value: "u1" };
  const firstMemory = await memory.list("posts", { limit: 2, where });
  const firstDurable = await durable.list("posts", { limit: 2, where });
  expect(firstMemory).toEqual(firstDurable);
  expect(firstMemory.items.map((document) => document.id)).toEqual(["b", "d"]);
  expect(decodeCursor(firstMemory.nextCursor!)).toEqual({
    v: 2,
    collection: "posts",
    where,
    id: "d",
  });

  const secondMemory = await memory.list("posts", {
    limit: 2,
    where,
    cursor: firstMemory.nextCursor,
  });
  const secondDurable = await durable.list("posts", {
    limit: 2,
    where,
    cursor: firstDurable.nextCursor,
  });
  expect(secondMemory).toEqual(secondDurable);
  expect(secondMemory.items.map((document) => document.id)).toEqual(["e"]);

  await expect(
    memory.list("comments", { where, cursor: firstMemory.nextCursor }),
  ).rejects.toBeInstanceOf(BadRequestError);
  await expect(
    memory.list("posts", {
      where: { field: "ownerId", op: "eq", value: "u2" },
      cursor: firstMemory.nextCursor,
    }),
  ).rejects.toBeInstanceOf(BadRequestError);
});

test("DO list reads bounded chunks and stops after finding the next match", async () => {
  const listCalls: {
    options: { prefix?: string; limit?: number; startAfter?: string };
    resultSize: number;
  }[] = [];
  const durable = createDurableObjectStorage(
    createFakeDurableObjectStorage((options, result) => {
      listCalls.push({ options, resultSize: result.size });
    }),
  );

  for (let index = 0; index < 300; index += 1) {
    const id = index.toString().padStart(3, "0");
    await durable.put("posts", meta({ id, selected: index === 0 || index === 128 }));
  }

  const page = await durable.list("posts", {
    limit: 1,
    where: { field: "selected", op: "eq", value: true },
  });

  expect(page.items.map((document) => document.id)).toEqual(["000"]);
  expect(page.nextCursor).toBeDefined();
  expect(listCalls).toEqual([
    {
      options: { prefix: "takibi:posts:", limit: 128 },
      resultSize: 128,
    },
    {
      options: {
        prefix: "takibi:posts:",
        limit: 128,
        startAfter: "takibi:posts:127",
      },
      resultSize: 128,
    },
  ]);
});

test("DO get reads only takibi:${resource}:${id}", async () => {
  const fake = createFakeDurableObjectStorage();
  const durable = createDurableObjectStorage(fake);
  await durable.put("posts", meta({ id: "p1", title: "hi" }));
  await fake.put("fire:posts:p2", meta({ id: "p2", title: "other" }));
  await fake.put("unrelated", meta({ id: "x", title: "nope" }));

  expect(await durable.get("posts", "p1")).toEqual(meta({ id: "p1", title: "hi" }));
  expect(await durable.get("posts", "p2")).toBeNull();
  expect(await durable.get("posts", "missing")).toBeNull();
});
