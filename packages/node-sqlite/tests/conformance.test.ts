import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSqlConformance } from "@takibi/sql-conformance";
import { openNodeSqliteExecutor } from "@takibi/node-sqlite";

describeSqlConformance("node:sqlite file", {
  async withDatabase(name, body) {
    const directory = mkdtempSync(join(tmpdir(), "takibi-conformance-"));
    const sql = openNodeSqliteExecutor(join(directory, `${name}.sqlite`));
    try {
      await body(sql);
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

describeSqlConformance("node:sqlite :memory:", {
  async withDatabase(_name, body) {
    const sql = openNodeSqliteExecutor(":memory:");
    try {
      await body(sql);
    } finally {
      sql.close();
    }
  },
});
