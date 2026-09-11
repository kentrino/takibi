import type { StorageDriver, StoredDocument } from "@takibi/storage";

const TS = "2026-08-31T00:00:00.000Z";

function document(id: string, owner: string, score: number): StoredDocument {
  return { id, owner, score, createdAt: TS, updatedAt: TS, rev: 1 };
}

export const expectedStorageContractObservation = {
  firstPage: ["a", "c"],
  secondPage: ["d"],
  committed: "committed",
  rolledBack: null,
} as const;

export async function observeStorageContract(storage: StorageDriver) {
  for (const item of [
    document("d", "u1", 30),
    document("a", "u1", 10),
    document("c", "u1", 20),
    document("b", "u2", 40),
  ]) {
    await storage.put("shared-contract", item);
  }

  const where = { field: "owner", op: "eq", value: "u1" } as const;
  const first = await storage.list("shared-contract", { where, limit: 2 });
  const second = await storage.list("shared-contract", {
    where,
    limit: 2,
    cursor: first.nextCursor,
  });

  await storage.transaction(async (transaction) => {
    await transaction.put("shared-contract", document("committed", "tx", 1));
    await transaction.transaction(async (nested) => {
      await nested.put("shared-contract", document("nested", "tx", 2));
    });
  });
  try {
    await storage.transaction(async (transaction) => {
      await transaction.put("shared-contract", document("rolled-back", "tx", 3));
      throw new Error("roll back shared contract write");
    });
  } catch {}

  return {
    firstPage: first.items.map(({ id }) => id),
    secondPage: second.items.map(({ id }) => id),
    committed: (await storage.get("shared-contract", "committed"))?.id ?? null,
    rolledBack: (await storage.get("shared-contract", "rolled-back"))?.id ?? null,
  };
}
