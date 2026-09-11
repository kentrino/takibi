import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  joinsTestSuite,
  normalTestSuite,
  testAdapter,
} from "@better-auth/test-utils/adapter";
import { createOfficialMemoryHarness } from "./official-memory-harness.server.ts";

const disabledTests = {
  "findOne - should find a model with modified field name": true,
  "findOne - should join a model with modified field name": true,
  "findOne - backwards join with modified field name (session base, users-table join)": true,
} as const;

await registerOfficialSuite("normal", normalTestSuite({ disableTests: disabledTests }));
await registerOfficialSuite("joins", joinsTestSuite({ disableTests: disabledTests }));
await registerOfficialSuite("case-insensitive", caseInsensitiveTestSuite());
await registerOfficialSuite("auth-flow", authFlowTestSuite());

async function registerOfficialSuite(
  name: string,
  suite: Parameters<typeof testAdapter>[0]["tests"][number],
) {
  const { databaseFor } = createOfficialMemoryHarness();
  const official = await testAdapter({
    adapter: async (options) => databaseFor(options),
    runMigrations: () => undefined,
    prefixTests: `official ${name}`,
    tests: [suite],
  });
  official.execute();
}
