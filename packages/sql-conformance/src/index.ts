import { describe } from "vite-plus/test";
import { defineSqlPortTests } from "./port";
import { defineRuntimeTests } from "./runtime";
import { defineStorageTests } from "./storage";
import type { ConformanceTarget } from "./target";
import { defineTransactionCallbackTests } from "./transaction-callback";

export type { ConformanceTarget } from "./target";
export { expectedStorageContractObservation, observeStorageContract } from "./storage";
export {
  checkTransactionCallbackContract,
  injectedTransactionStorage,
  transactionCases,
  transactionWrappers,
  type TransactionCase,
} from "./transaction-callback";

/**
 * Register the whole conformance suite for one backend. A SQL connection is
 * supported only when this suite passes on it (RFC 0015): the SQL port
 * contract and the SQLite features the engine uses, the storage driver
 * (lists, cursors, isolation, layout, index reconciliation), the transaction
 * callback no-replay contract, and the tenant runtime (uniqueness, seeds,
 * trusted transactions, maintenance lease, snapshot export/restore/reset).
 */
export function describeSqlConformance(backend: string, target: ConformanceTarget): void {
  describe(`SQL conformance: ${backend}`, () => {
    defineSqlPortTests(target);
    defineStorageTests(target);
    defineTransactionCallbackTests(target);
    defineRuntimeTests(target);
  });
}
