import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { test } from "vite-plus/test";
import {
  checkTransactionCallbackContract,
  transactionCases,
  transactionWrappers,
} from "./transaction-callback-contract";
import type { StorageTestObject } from "./worker";

for (const [name, wrapper] of Object.entries(transactionWrappers)) {
  for (const scenario of transactionCases) {
    test(`Workers ${name}: ${scenario} does not replay callbacks`, async () => {
      const stub = env.TAKIBI_STORAGE_TEST.getByName(
        `callback-${name}-${scenario}`,
      ) as DurableObjectStub<StorageTestObject>;
      await stub.ping();
      await runInDurableObject(stub, async (_instance, state) => {
        await checkTransactionCallbackContract(state.storage, wrapper, scenario);
      });
    });
  }
}
