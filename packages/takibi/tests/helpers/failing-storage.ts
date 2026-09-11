import { createSqliteDurableObjectStorage } from "@takibi/takibi-testing/sqlite-storage";

export function createFailingDocumentWriteStorage(): DurableObjectStorage {
  const storage = createSqliteDurableObjectStorage();
  const exec = storage.sql.exec.bind(storage.sql);
  storage.sql.exec = ((query: string, ...bindings: never[]) => {
    if (query.includes("INSERT INTO takibi_documents")) {
      throw new Error("storage-failed");
    }
    return exec(query, ...bindings);
  }) as DurableObjectStorage["sql"]["exec"];
  return storage;
}
