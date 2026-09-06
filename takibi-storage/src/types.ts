import type { StorageListOptions, WithMetadata } from "@takibi/takibi-shared-types";
import { TAKIBI_VERSION_KEY } from "@takibi/takibi-shared-types";

/** @internal Persisted representation. The version marker never crosses the storage boundary. */
export type StoredDocument = WithMetadata<Record<string, unknown>> & {
  [TAKIBI_VERSION_KEY]?: unknown;
};

export type StorageReadTransform = (
  document: StoredDocument,
) => Promise<WithMetadata<Record<string, unknown>>>;

export type StorageListPlan = {
  currentVersion: number;
  transform: StorageReadTransform;
};

export type StorageDriver = {
  get(resource: string, id: string): Promise<StoredDocument | null>;
  put(resource: string, doc: StoredDocument): Promise<void>;
  delete(resource: string, id: string): Promise<boolean>;
  list(
    resource: string,
    opts?: StorageListOptions,
    plan?: StorageListPlan,
  ): Promise<{ items: WithMetadata<Record<string, unknown>>[]; nextCursor?: string }>;
  transaction<T>(callback: (storage: StorageDriver) => Promise<T>): Promise<T>;
};
