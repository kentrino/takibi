import { expect, test } from "vite-plus/test";
import { executePlan, type ExecutionPlan } from "@takibi/invocation-lifecycle";

type Storage = { readonly scope: "base" | "transaction" };

const baseStorage: Storage = { scope: "base" };
const transactionStorage: Storage = { scope: "transaction" };

function createContracts(log: string[]) {
  const stage = (name: string) => ({
    prepare: (work: string, storage: Storage) => {
      log.push(`${name}.prepare:${work}@${storage.scope}`);
      return `${work}:prepared`;
    },
    apply: (prepared: string, storage: Storage) => {
      log.push(`${name}.apply:${prepared}@${storage.scope}`);
      return `${name}:${prepared}@${storage.scope}`;
    },
  });
  return { none: stage("none"), apply: stage("apply"), full: stage("full") };
}

test("none boundary prepares and applies on base storage without a transaction", async () => {
  const log: string[] = [];
  const plan: ExecutionPlan<string, string, string> = { transactionBoundary: "none", work: "get" };
  const result = await executePlan({
    plan,
    storage: baseStorage,
    runInTransaction: () => {
      throw new Error("none boundary must not open a transaction");
    },
    ...createContracts(log),
  });

  expect(result).toBe("none:get:prepared@base");
  expect(log).toEqual(["none.prepare:get@base", "none.apply:get:prepared@base"]);
});

test("apply boundary prepares on base storage and applies inside the transaction", async () => {
  const log: string[] = [];
  let transactions = 0;
  const plan: ExecutionPlan<string, string, string> = { transactionBoundary: "apply", work: "add" };
  const result = await executePlan({
    plan,
    storage: baseStorage,
    runInTransaction: async (work) => {
      transactions += 1;
      return work(transactionStorage);
    },
    ...createContracts(log),
  });

  expect(result).toBe("apply:add:prepared@transaction");
  expect(transactions).toBe(1);
  expect(log).toEqual(["apply.prepare:add@base", "apply.apply:add:prepared@transaction"]);
});

test("full boundary prepares and applies inside one transaction", async () => {
  const log: string[] = [];
  let transactions = 0;
  const plan: ExecutionPlan<string, string, string> = {
    transactionBoundary: "full",
    work: "register",
  };
  const result = await executePlan({
    plan,
    storage: baseStorage,
    runInTransaction: async (work) => {
      transactions += 1;
      return work(transactionStorage);
    },
    ...createContracts(log),
  });

  expect(result).toBe("full:register:prepared@transaction");
  expect(transactions).toBe(1);
  expect(log).toEqual([
    "full.prepare:register@transaction",
    "full.apply:register:prepared@transaction",
  ]);
});

test("reuseTransaction runs the apply boundary on base storage without opening one", async () => {
  const log: string[] = [];
  const plan: ExecutionPlan<string, string, string> = { transactionBoundary: "apply", work: "add" };
  const result = await executePlan({
    plan,
    storage: baseStorage,
    reuseTransaction: true,
    runInTransaction: () => {
      throw new Error("reuseTransaction must not open a nested transaction");
    },
    ...createContracts(log),
  });

  expect(result).toBe("apply:add:prepared@base");
  expect(log).toEqual(["apply.prepare:add@base", "apply.apply:add:prepared@base"]);
});

test("reuseTransaction runs the full boundary on base storage without opening one", async () => {
  const log: string[] = [];
  const plan: ExecutionPlan<string, string, string> = {
    transactionBoundary: "full",
    work: "register",
  };
  const result = await executePlan({
    plan,
    storage: baseStorage,
    reuseTransaction: true,
    runInTransaction: () => {
      throw new Error("reuseTransaction must not open a nested transaction");
    },
    ...createContracts(log),
  });

  expect(result).toBe("full:register:prepared@base");
  expect(log).toEqual(["full.prepare:register@base", "full.apply:register:prepared@base"]);
});
