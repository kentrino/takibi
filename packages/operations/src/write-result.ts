import { allows, type AccessGrant } from "@takibi/policy";
import type { WithMetadata } from "@takibi/shared-types";

/** Writes collate `update`/`create`. The stored document is only returned when the same grant includes `get`. */
export function writeResult(doc: WithMetadata<Record<string, unknown>>, granted: AccessGrant) {
  if (allows(granted, "get")) return doc;
  return { id: doc.id, updatedAt: doc.updatedAt, rev: doc.rev };
}
