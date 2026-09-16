import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess } from "takibi";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";

const metadata = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  revision: 7,
};

function snapshot(values: Record<string, unknown>[], schemaVersion = 0, corrupt = false) {
  const records = [
    {
      type: "header",
      format: "takibi.logical-snapshot",
      version: 1,
      collections: [{ name: "records", schemaVersion }],
    },
    ...values.map((data, index) => ({
      type: "document",
      collection: "records",
      id: `r${index}`,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      schemaVersion,
      revision: metadata.revision,
      data,
    })),
  ];
  const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  return `${body}${JSON.stringify({
    type: "trailer",
    counts: { records: values.length },
    sha256: corrupt ? "0".repeat(64) : bytesToHex(sha256(new TextEncoder().encode(body))),
  })}\n`;
}

function createObject(
  options: {
    migrate?: (data: unknown) => { slug: string; score: number };
    allowInvalidScore?: boolean;
    seed?: () => Record<string, { slug: string; score: number }>;
  } = {},
) {
  const migrate = vi.fn(
    options.migrate ??
      ((data: unknown) => {
        const old = data as { title: string; score: number };
        return { slug: old.title.toLowerCase(), score: 100 - old.score };
      }),
  );
  const validate = vi.fn((data: { slug: string; score: number }) => data);
  const handler = createTakibi()({ resolve: () => ({ tenantId: "preparation" }) })
    .defineCollections({
      records: {
        schema: z
          .object({
            slug: z.string().trim(),
            score: options.allowInvalidScore ? z.custom<number>() : z.number(),
          })
          .transform(validate),
        migrations: { steps: [migrate] },
        accessPolicy: fullAccess,
        indexes: { bySlug: ["slug"], byScore: ["score"] },
        unique: { bySlug: ["slug"] },
        ...(options.seed ? { seed: options.seed } : {}),
      },
    })
    .actions({});
  const backing = createSqliteDurableObjectStorage();
  const object = new handler.DurableObject(
    {
      storage: backing,
      id: { name: "preparation" },
      blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
    } as unknown as DurableObjectState,
    {},
  );
  const restore = (encoded: string) =>
    object.$collections.$restoreSnapshot(new Blob([encoded]).stream());
  const rows = () =>
    backing.sql.exec("SELECT * FROM takibi_documents ORDER BY collection, id").toArray();
  return { object, restore, rows, migrate, validate };
}

test("restore publishes current index values, exact metadata, and stable logical re-exports", async () => {
  const target = createObject({ seed: () => ({ seed: { slug: "seed", score: 99 } }) });
  await target.object.$collections.records.list();
  target.validate.mockClear();
  await target.restore(
    snapshot([
      { title: " Zebra ", score: 90 },
      { title: "Alpha", score: 80 },
      { title: "Middle", score: 70 },
    ]),
  );
  expect(target.migrate).toHaveBeenCalledTimes(3);
  expect(target.validate).toHaveBeenCalledTimes(4); // Three documents and one seed.
  const rows = target.rows();
  for (const [index, data] of [
    { slug: "zebra", score: 10 },
    { slug: "alpha", score: 20 },
    { slug: "middle", score: 30 },
  ].entries()) {
    expect(rows[index]).toMatchObject({
      collection: "records",
      id: `r${index}`,
      schema_version: 1,
      created_at: metadata.createdAt,
      updated_at: metadata.updatedAt,
      revision: metadata.revision,
      data: JSON.stringify(data),
    });
  }
  const records = target.object.$collections.records;
  await expect(
    records.list({ index: "bySlug", where: (q) => q.slug.eq("zebra") }),
  ).resolves.toMatchObject({ items: [{ id: "r0", slug: "zebra" }] });
  const page = (cursor?: string) =>
    records.list({
      index: "byScore",
      where: (q) => q.score.gte(20),
      orderBy: (q) => q.score.desc(),
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
  const first = await page();
  expect(first.items.map((item) => item.id)).toEqual(["seed"]);
  expect(first.nextCursor).toBeDefined();
  const second = await page(first.nextCursor);
  expect(second.items.map((item) => item.id)).toEqual(["r2"]);
  expect(second.nextCursor).toBeDefined();
  const third = await page(second.nextCursor);
  expect(third.items.map((item) => item.id)).toEqual(["r1"]);
  expect(third.nextCursor).toBeUndefined();
  const encoded = await new Response(await target.object.$collections.$exportSnapshot()).text();
  const fresh = createObject({ seed: () => ({ seed: { slug: "seed", score: 99 } }) });
  await fresh.object.$collections.records.list();
  fresh.validate.mockClear();
  await fresh.restore(encoded);
  expect(fresh.rows()).toEqual(rows);
  expect(fresh.migrate).not.toHaveBeenCalled();
  expect(fresh.validate).toHaveBeenCalledTimes(5); // Four current documents and one seed.
});

test("current-version schema transforms are materialized before indexed reads", async () => {
  const target = createObject();
  await target.restore(snapshot([{ slug: " trimmed ", score: 1 }], 1));
  await expect(
    target.object.$collections.records.list({
      index: "bySlug",
      where: (q) => q.slug.eq("trimmed"),
    }),
  ).resolves.toMatchObject({ items: [{ id: "r0", slug: "trimmed" }] });
  expect(target.migrate).not.toHaveBeenCalled();
  expect(target.validate).toHaveBeenCalledTimes(1);
});

test.each(["migration", "schema", "index", "unique", "seed", "checksum"] as const)(
  "restore %s failure preserves all live rows",
  async (failure) => {
    const target = createObject({
      ...(failure === "migration"
        ? {
            migrate: () => {
              throw new Error("migration failed");
            },
          }
        : {}),
      ...(failure === "schema"
        ? { migrate: () => ({ slug: 123 as unknown as string, score: 1 }) }
        : {}),
      ...(failure === "index"
        ? {
            allowInvalidScore: true,
            migrate: () => ({ slug: "invalid", score: {} as number }),
          }
        : {}),
      ...(failure === "seed" ? { seed: () => ({ seed: { slug: "same", score: 1 } }) } : {}),
    });
    await target.object.$collections.records.add({ slug: "live", score: 42 }, { id: "live" });
    const before = target.rows();
    const values = [{ title: "SAME", score: 1 }];
    if (failure === "unique") values.push({ title: "same", score: 2 });
    await expect(target.restore(snapshot(values, 0, failure === "checksum"))).rejects.toMatchObject(
      {
        code: failure === "checksum" ? "SNAPSHOT_FORMAT" : "SNAPSHOT_INVALID_DOCUMENT",
      },
    );
    expect(target.rows()).toEqual(before);
  },
);
