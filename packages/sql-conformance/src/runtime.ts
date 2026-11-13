import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { ActionRegistry, defineCollection, type CollectionsDef } from "@takibi/api";
import { fullAccess } from "@takibi/policy";
import { SqliteMaintenanceBackend } from "@takibi/snapshot";
import type { SqlExecutor } from "@takibi/storage";
import { createTenantRuntime } from "@takibi/worker-runtime";
import type { ConformanceTarget } from "./target";

const definitions = {
  members: defineCollection({
    schema: z.object({ email: z.string(), name: z.string(), score: z.number() }),
    accessPolicy: fullAccess,
    unique: { byEmail: ["email"] },
    indexes: { byScore: ["score"] },
    seed: async () => ({ founder: { email: "founder@example.test", name: "Founder", score: 0 } }),
  }),
};
// `CollectionsDef` erases schemas; typed definitions need one explicit widening.
const collections = definitions as unknown as CollectionsDef;

type Member = { id: string; email: string; name: string; score: number };
type Members = {
  add(input: Omit<Member, "id">, options?: { id?: string }): Promise<Member>;
  get(id: string): Promise<Member>;
  list(options?: object): Promise<{ items: Member[]; nextCursor?: string }>;
};

/** A tenant runtime over `sql` on a host that runs startup at once and has no watch. */
function tenant(sql: SqlExecutor) {
  const runtime = createTenantRuntime({
    collections,
    registry: new ActionRegistry(),
    logger: undefined,
    services: {},
    sql,
    host: { runStartup: (startup) => startup() },
  });
  const api = runtime.collectionsApi as unknown as {
    members: Members;
    $transaction<T>(callback: (tx: { members: Members }) => Promise<T>): Promise<T>;
    $exportSnapshot(): Promise<ReadableStream<Uint8Array>>;
    $restoreSnapshot(source: ReadableStream<Uint8Array>): Promise<{ documentsRestored: number }>;
    $resetAll(): Promise<void>;
  };
  return { runtime, api };
}

async function ids(members: Members): Promise<string[]> {
  return (await members.list({ limit: 100 })).items.map(({ id }) => id).sort();
}

/** The tenant runtime's uniqueness, transactions, seeds, maintenance, and snapshots. */
export function defineRuntimeTests(target: ConformanceTarget): void {
  describe("tenant runtime", () => {
    test("seeds once and enforces uniqueness, also under concurrent writes", () =>
      target.withDatabase("runtime-unique", async (sql) => {
        const { runtime, api } = tenant(sql);
        await runtime.ready;
        expect(await ids(api.members)).toEqual(["founder"]);
        await expect(
          api.members.add(
            { email: "founder@example.test", name: "Copy", score: 1 },
            { id: "copy" },
          ),
        ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

        const attempts = await Promise.allSettled(
          Array.from({ length: 20 }, (_, index) =>
            api.members.add(
              { email: "race@example.test", name: `Racer ${index}`, score: index },
              { id: `racer-${index}` },
            ),
          ),
        );
        expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        for (const attempt of attempts) {
          if (attempt.status === "rejected") {
            expect(attempt.reason).toMatchObject({ code: "ALREADY_EXISTS" });
          }
        }
        await runtime.close();

        // A restarted tenant on the same database does not seed again.
        const restarted = tenant(sql);
        await restarted.runtime.ready;
        expect((await ids(restarted.api.members)).filter((id) => id === "founder")).toHaveLength(1);
        await restarted.runtime.close();
      }));

    test("a trusted transaction commits atomically or not at all", () =>
      target.withDatabase("runtime-transaction", async (sql) => {
        const { runtime, api } = tenant(sql);
        await runtime.ready;
        await api.$transaction(async (tx) => {
          await tx.members.add({ email: "a@example.test", name: "A", score: 1 }, { id: "a" });
          await tx.members.add({ email: "b@example.test", name: "B", score: 2 }, { id: "b" });
        });
        const failure = new Error("abort");
        await expect(
          api.$transaction(async (tx) => {
            await tx.members.add({ email: "c@example.test", name: "C", score: 3 }, { id: "c" });
            throw failure;
          }),
        ).rejects.toBe(failure);
        // A uniqueness violation inside the transaction rolls back its earlier writes.
        await expect(
          api.$transaction(async (tx) => {
            await tx.members.add({ email: "d@example.test", name: "D", score: 4 }, { id: "d" });
            await tx.members.add({ email: "a@example.test", name: "A2", score: 5 }, { id: "a2" });
          }),
        ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
        expect(await ids(api.members)).toEqual(["a", "b", "founder"]);
        await runtime.close();
      }));

    test("the maintenance lease excludes a second owner until it expires or is released", () =>
      target.withDatabase("runtime-lease", async (sql) => {
        const backend = await SqliteMaintenanceBackend.open(sql);
        const held = await backend.acquire("owner-a", "export", 30);
        expect(held?.expiresAt).toBeGreaterThan(Date.now());
        await expect(backend.acquire("owner-b", "reset", 30)).resolves.toBeUndefined();
        await expect(backend.renew("owner-a", "export", 30)).resolves.toBeGreaterThan(Date.now());
        await expect(backend.renew("owner-b", "reset", 30)).resolves.toBeUndefined();
        await backend.release("owner-a");
        // A lease with no time left can be taken over at once.
        await expect(backend.acquire("owner-b", "reset", 0)).resolves.toBeDefined();
        await expect(backend.acquire("owner-c", "restore", 30)).resolves.toBeDefined();
        await expect(backend.renew("owner-b", "reset", 30)).resolves.toBeUndefined();
        await backend.cleanupAbandoned();
        await expect(backend.acquire("owner-d", "export", 30)).resolves.toBeDefined();
      }));

    test("snapshot export, reset, and restore round-trip under the maintenance lease", () =>
      target.withDatabase("runtime-snapshot", async (sql) => {
        const { runtime, api } = tenant(sql);
        await runtime.ready;
        await api.members.add(
          { email: "kept@example.test", name: "Kept", score: 7 },
          { id: "kept" },
        );
        const stream = await api.$exportSnapshot();
        await expect(api.members.get("kept")).rejects.toMatchObject({ code: "MAINTENANCE_LOCKED" });
        const encoded = await new Response(stream).text();

        await api.members.add(
          { email: "later@example.test", name: "Later", score: 8 },
          { id: "later" },
        );
        await api.$resetAll();
        expect(await ids(api.members)).toEqual(["founder"]);

        const report = await api.$restoreSnapshot(
          new Blob([encoded]).stream() as ReadableStream<Uint8Array>,
        );
        expect(report).toMatchObject({ documentsRestored: 2 });
        expect(await ids(api.members)).toEqual(["founder", "kept"]);
        await expect(api.members.get("kept")).resolves.toMatchObject({ score: 7 });
        // Uniqueness holds against restored documents.
        await expect(
          api.members.add({ email: "kept@example.test", name: "Dup", score: 1 }, { id: "dup" }),
        ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
        // A restore that fails validation changes nothing.
        await expect(
          api.$restoreSnapshot(
            new Blob(["not a snapshot\n"]).stream() as ReadableStream<Uint8Array>,
          ),
        ).rejects.toBeDefined();
        expect(await ids(api.members)).toEqual(["founder", "kept"]);
        await runtime.close();
      }));
  });
}
