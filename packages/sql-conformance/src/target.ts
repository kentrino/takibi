import type { SqlExecutor } from "@takibi/storage";

/** How the suite reaches a fresh database on the backend under test. */
export type ConformanceTarget = {
  /**
   * Run `body` against a new, empty database behind a {@link SqlExecutor}
   * built the way production builds it for this backend, then release it.
   * `name` is unique per test, for backends that address databases by name.
   */
  withDatabase(name: string, body: (sql: SqlExecutor) => Promise<void>): Promise<void>;
};

/** Spread a result row into a plain object, so rows compare equal across drivers. */
export function plain<Row extends object>(row: Row | undefined): Row | undefined {
  return row === undefined ? undefined : { ...row };
}
