import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createDurableObjectSqlExecutor } from "@takibi/worker-runtime";
import { describeSqlConformance } from "@takibi/sql-conformance";
import type { StorageTestObject } from "./worker";

// The Durable Object connection, exactly as the generated Durable Object
// builds it, against the same suite every other connection passes.
describeSqlConformance("Durable Object", {
  async withDatabase(name, body) {
    const stub = env.TAKIBI_STORAGE_TEST.getByName(
      `conformance-${name}`,
    ) as DurableObjectStub<StorageTestObject>;
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) =>
      body(createDurableObjectSqlExecutor(state.storage)),
    );
  },
});
