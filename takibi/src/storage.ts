import { BadRequestError } from "./errors";
import { matchesQuery, normalizeQueryExpr } from "./query";
import type { QueryExpr, StorageDriver, StorageListOptions, WithMetadata } from "./types";

type ListCursorV2 = {
  v: 2;
  collection: string;
  where: QueryExpr | null;
  id: string;
};

export function createMemoryStorage(): StorageDriver {
  const tables = new Map<string, Map<string, WithMetadata<Record<string, unknown>>>>();

  const table = (resource: string) => {
    let t = tables.get(resource);
    if (!t) {
      t = new Map();
      tables.set(resource, t);
    }
    return t;
  };

  return {
    async get(resource, id) {
      return table(resource).get(id) ?? null;
    },
    async put(resource, doc) {
      table(resource).set(doc.id, structuredClone(doc));
    },
    async delete(resource, id) {
      return table(resource).delete(id);
    },
    async list(resource, opts) {
      return paginate(resource, [...table(resource).values()], opts);
    },
  };
}

export function createDurableObjectStorage(storage: DurableObjectStorage): StorageDriver {
  const keyOf = (resource: string, id: string) => `takibi:${resource}:${id}`;
  const prefixOf = (resource: string) => `takibi:${resource}:`;

  return {
    async get(resource, id) {
      return (
        (await storage.get<WithMetadata<Record<string, unknown>>>(keyOf(resource, id))) ?? null
      );
    },
    async put(resource, doc) {
      await storage.put(keyOf(resource, doc.id), doc);
    },
    async delete(resource, id) {
      return storage.delete(keyOf(resource, id));
    },
    async list(resource, opts) {
      const prefix = prefixOf(resource);
      const result = await storage.list<WithMetadata<Record<string, unknown>>>({
        prefix,
      });
      return paginate(resource, [...result.values()], opts);
    },
  };
}

/**
 * Shared unindexed query and pagination semantics. Filtering happens before the
 * cursor and limit, and both drivers return the same id-ordered pages.
 */
function paginate(
  resource: string,
  items: WithMetadata<Record<string, unknown>>[],
  opts?: StorageListOptions,
): { items: WithMetadata<Record<string, unknown>>[]; nextCursor?: string } {
  let where: QueryExpr | undefined;
  try {
    where = opts?.where === undefined ? undefined : normalizeQueryExpr(opts.where);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : "Invalid query");
  }

  const cursor = opts?.cursor === undefined ? undefined : decodeCursor(opts.cursor);
  if (cursor !== undefined && (cursor.collection !== resource || !sameQuery(cursor.where, where))) {
    throw new BadRequestError("Cursor does not match this collection and query");
  }

  const sorted = items
    .filter((document) => (where ? matchesQuery(document, where) : true))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const start = cursor ? sorted.findIndex((document) => document.id > cursor.id) : 0;
  if (start < 0) return { items: [] };
  const page = sorted.slice(start, start + limit);
  const next = sorted[start + limit];
  const last = page.at(-1);
  return next && last
    ? { items: page, nextCursor: encodeCursor(resource, where, last.id) }
    : { items: page };
}

function sameQuery(cursorWhere: QueryExpr | null, where: QueryExpr | undefined): boolean {
  return JSON.stringify(cursorWhere) === JSON.stringify(where ?? null);
}

function encodeCursor(collection: string, where: QueryExpr | undefined, id: string): string {
  const cursor: ListCursorV2 = {
    v: 2,
    collection,
    where: where ?? null,
    id,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(token: string): ListCursorV2 {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length % 4 === 1) {
      throw new Error("Invalid base64url");
    }
    const base64 = token.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const value = JSON.parse(json) as unknown;
    if (!isRecord(value)) throw new Error("Invalid cursor object");
    assertExactCursorKeys(value);
    if (
      value.v !== 2 ||
      typeof value.collection !== "string" ||
      value.collection.length === 0 ||
      typeof value.id !== "string" ||
      value.id.length === 0
    ) {
      throw new Error("Invalid cursor fields");
    }
    const where = value.where === null ? null : normalizeQueryExpr(value.where);
    return { v: 2, collection: value.collection, where, id: value.id };
  } catch {
    throw new BadRequestError("Invalid list cursor");
  }
}

function assertExactCursorKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value);
  const expected = ["v", "collection", "where", "id"];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("Invalid cursor fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
