import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "vite-plus/test";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";
import {
  bindTracer,
  registerTracingContextBackend,
  type TracingContextBackend,
} from "../src/tracing";
import { createRecordingTracer } from "./helpers/recording-tracer";
import {
  checkTransactionCallbackContract,
  transactionCases,
  transactionWrappers,
} from "./transaction-callback-contract";

for (const [name, wrap] of Object.entries(transactionWrappers)) {
  for (const scenario of transactionCases) {
    test(`${name}: ${scenario} does not replay callbacks`, async () => {
      const raw = createSqliteDurableObjectStorage();
      const context = new AsyncLocalStorage<Parameters<TracingContextBackend["run"]>[0]>();
      registerTracingContextBackend({
        getStore: () => context.getStore(),
        run: (store, fn) => context.run(store, fn),
      });
      const { tracer, spans } = createRecordingTracer();
      try {
        await bindTracer(tracer, () =>
          checkTransactionCallbackContract(raw, wrap, scenario, "driver"),
        );
        await bindTracer(tracer, () =>
          checkTransactionCallbackContract(raw, wrap, scenario, "trusted", true),
        );
        if (name === "tracing" || name === "composed") expect(spans.length).toBeGreaterThan(0);
      } finally {
        registerTracingContextBackend(undefined);
        context.disable();
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
        (driver) => ({
          ...driver,
          transaction: (callback) =>
            driver.transaction(async (scope) => {
              await callback(scope);
              return callback(scope);
            }),
        }),
        "success",
        "replayed",
      ),
    ).rejects.toThrow("transaction callbacks must not be replayed");
  } finally {
    raw.close();
  }
});
