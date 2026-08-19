import { BadRequestError } from "./errors";
import { matchesQuery, normalizeQueryExpr } from "./query";
import type {
  QueryExpr,
  StorageDriver,
  StorageListOptions,
  StorageReadTransform,
  StoredDocument,
  WithMetadata,
} from "./types";

type ListCursorV2 = {
  v: 2;
  collection: string;
  where: QueryExpr | null;
  id: string;
};

const LIST_CHUNK_SIZE = 128;

type ScanItem = {
  id: string;
  document: StoredDocument;
};

type ReadChunk = (startAfter: string | undefined, limit: number) => Promise<ScanItem[]>;

export function createMemoryStorage(): StorageDriver {
  const tables = new Map<string, Map<string, StoredDocument>>();

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
    async list(resource, opts, transform) {
      const items = [...table(resource).values()]
        .sort((a, b) => compareIds(a.id, b.id))
        .map((document) => ({ id: document.id, document }));
      return paginate(
        resource,
        opts,
        async (startAfter, limit) => {
          const start =
            startAfter === undefined ? 0 : items.findIndex((item) => item.id > startAfter);
          return start < 0 ? [] : items.slice(start, start + limit);
        },
        transform,
      );
    },
  };
}

export function createDurableObjectStorage(storage: DurableObjectStorage): StorageDriver {
  const keyOf = (resource: string, id: string) => `takibi:${resource}:${id}`;
  const prefixOf = (resource: string) => `takibi:${resource}:`;

  return {
    async get(resource, id) {
      return (await storage.get<StoredDocument>(keyOf(resource, id))) ?? null;
    },
    async put(resource, doc) {
      await storage.put(keyOf(resource, doc.id), doc);
    },
    async delete(resource, id) {
      return storage.delete(keyOf(resource, id));
    },
    async list(resource, opts, transform) {
      const prefix = prefixOf(resource);
      return paginate(
        resource,
        opts,
        async (startAfter, limit) => {
          const result = await storage.list<StoredDocument>({
            prefix,
            limit,
            ...(startAfter === undefined ? {} : { startAfter: keyOf(resource, startAfter) }),
          });
          return [...result].map(([key, document]) => ({
            id: key.slice(prefix.length),
            document,
          }));
        },
        transform,
      );
    },
  };
}

/**
 * Shared unindexed query and pagination semantics. Filtering happens before the
 * limit, and only the current scan chunk and return page remain live.
 */
async function paginate(
  resource: string,
  opts: StorageListOptions | undefined,
  readChunk: ReadChunk,
  transform?: StorageReadTransform,
): Promise<{ items: WithMetadata<Record<string, unknown>>[]; nextCursor?: string }> {
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

  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const page: WithMetadata<Record<string, unknown>>[] = [];
  let startAfter = cursor?.id;

  while (true) {
    const chunk = await readChunk(startAfter, LIST_CHUNK_SIZE);
    if (chunk.length === 0) break;

    for (const item of chunk) {
      startAfter = item.id;
      const document = transform ? await transform(item.document) : item.document;
      if (where && !matchesQuery(document, where)) continue;
      if (page.length === limit) {
        const last = page.at(-1)!;
        return { items: page, nextCursor: encodeCursor(resource, where, last.id) };
      }
      page.push(document);
    }

    if (chunk.length < LIST_CHUNK_SIZE) break;
  }

  return { items: page };
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
