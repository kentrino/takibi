import type { StorageListOptions, WithMetadata } from "@takibi/shared-types";
import { TAKIBI_VERSION_KEY } from "@takibi/shared-types";

/** @internal Persisted representation. The version marker never crosses the storage boundary. */
export type StoredDocument = WithMetadata<Record<string, unknown>> & {
  [TAKIBI_VERSION_KEY]?: unknown;
};

export type StorageReadTransform = (
  document: StoredDocument,
) => Promise<WithMetadata<Record<string, unknown>> | null>;

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
  /**
   * Invokes the callback at most once per call in one invocation attempt (zero
   * times if admission fails). Nested calls join the enclosing transaction;
   * each explicitly supplied callback has the same at-most-once guarantee.
   * Drivers and wrappers must never replay work after execution, rollback, or
   * commit failure, including an unknown commit outcome. Replaying backends
   * are unsupported; callers must not rely on the runtime to repair them.
   * This does not deduplicate separate invocations or make external effects
   * transactional or exactly once.
   */
  transaction<T>(callback: (storage: StorageDriver) => Promise<T>): Promise<T>;
};
