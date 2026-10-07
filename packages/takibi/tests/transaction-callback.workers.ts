import { AsyncLocalStorage } from "node:async_hooks";
import {
  bindTracer,
  registerTracingContextBackend,
  type TracingContextBackend,
} from "../src/tracing";
import { createRecordingTracer } from "./helpers/recording-tracer";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import {
  checkTransactionCallbackContract,
  transactionCases,
  transactionWrappers,
} from "./transaction-callback-contract";
import type { StorageTestObject } from "./worker";

for (const [name, wrap] of Object.entries(transactionWrappers)) {
  for (const scenario of transactionCases) {
    test(`Workers ${name}: ${scenario} does not replay callbacks`, async () => {
      const stub = env.TAKIBI_STORAGE_TEST.getByName(
        `callback-${name}-${scenario}`,
      ) as DurableObjectStub<StorageTestObject>;
      await stub.ping();
      await runInDurableObject(stub, async (_instance, state) => {
        const context = new AsyncLocalStorage<Parameters<TracingContextBackend["run"]>[0]>();
        registerTracingContextBackend({
          getStore: () => context.getStore(),
          run: (store, fn) => context.run(store, fn),
        });
        const { tracer, spans } = createRecordingTracer();
        try {
          await bindTracer(tracer, () =>
            checkTransactionCallbackContract(state.storage, wrap, scenario, "driver"),
          );
          await bindTracer(tracer, () =>
            checkTransactionCallbackContract(state.storage, wrap, scenario, "trusted", true),
          );
          if (name === "tracing" || name === "composed") expect(spans.length).toBeGreaterThan(0);
        } finally {
          registerTracingContextBackend(undefined);
        }
      });
    });
  }
}
