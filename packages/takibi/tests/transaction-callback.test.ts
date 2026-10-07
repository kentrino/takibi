import { expect, test } from "vite-plus/test";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";
import {
  checkTransactionCallbackContract,
  transactionCases,
  transactionWrappers,
} from "./transaction-callback-contract";

for (const [name, wrapper] of Object.entries(transactionWrappers)) {
  for (const scenario of transactionCases) {
    test(`${name}: ${scenario} does not replay callbacks`, async () => {
      const raw = createSqliteDurableObjectStorage();
      try {
        await checkTransactionCallbackContract(raw, wrapper, scenario);
      } finally {
        raw.close();
      }
    });
  }
}

test("conformance check detects an unsupported replaying driver", async () => {
  const raw = createSqliteDurableObjectStorage();
  try {
    await expect(
      checkTransactionCallbackContract(
        raw,
        {
          expectsSpans: false,
          wrap: (driver) => ({
            ...driver,
            transaction: (callback) =>
              driver.transaction(async (scope) => {
                await callback(scope);
                return callback(scope);
              }),
          }),
        },
        "success",
      ),
    ).rejects.toThrow("transaction callbacks must not be replayed");
  } finally {
    raw.close();
  }
});
