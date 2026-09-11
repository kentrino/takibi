import { expect, test } from "vite-plus/test";
import * as StoragePkg from "@takibi/storage";
import * as IndexFacade from "../src/indexes";
import * as IndexReconcileFacade from "../src/index-reconcile";
import * as IndexSqlFacade from "../src/index-sql";
import * as RevisionFacade from "../src/revision";
import * as SqlQueryFacade from "../src/sql-query";
import * as StorageFacade from "../src/storage";

test("Takibi storage modules re-export the owner package bindings", () => {
  expect(StorageFacade.createDurableObjectStorage).toBe(StoragePkg.createDurableObjectStorage);
  expect(IndexFacade.compileIndexRegistry).toBe(StoragePkg.compileIndexRegistry);
  expect(IndexFacade.resolveIndexedList).toBe(StoragePkg.resolveIndexedList);
  expect(IndexSqlFacade.physicalIndexName).toBe(StoragePkg.physicalIndexName);
  expect(IndexSqlFacade.compileIndexedScanSql).toBe(StoragePkg.compileIndexedScanSql);
  expect(IndexReconcileFacade.reconcileCollectionIndexes).toBe(
    StoragePkg.reconcileCollectionIndexes,
  );
  expect(SqlQueryFacade.compileQueryToSql).toBe(StoragePkg.compileQueryToSql);
  expect(RevisionFacade.documentRevision).toBe(StoragePkg.documentRevision);
  expect(RevisionFacade.withDocumentRevision).toBe(StoragePkg.withDocumentRevision);
});
