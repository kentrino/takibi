import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describeSqlConformance } from "@takibi/sql-conformance";
import { openLibsqlExecutor } from "@takibi/libsql";

// Local databases only: no network, no Turso account. Remote URLs and
// embedded-replica sync are not covered here.
describeSqlConformance("libSQL file", {
  async withDatabase(name, body) {
    const directory = mkdtempSync(join(tmpdir(), "takibi-libsql-conformance-"));
    const sql = await openLibsqlExecutor({
      url: pathToFileURL(join(directory, `${name}.db`)).href,
    });
    try {
      await body(sql);
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

describeSqlConformance("libSQL :memory:", {
  async withDatabase(_name, body) {
    const sql = await openLibsqlExecutor({ url: ":memory:" });
    try {
      await body(sql);
    } finally {
      sql.close();
    }
  },
});
