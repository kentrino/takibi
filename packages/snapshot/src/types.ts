export type MaintenancePurpose = "export" | "restore" | "reset";

export type SnapshotStoredDocument = {
  collection: string;
  id: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  revision: number;
  data: Record<string, unknown>;
};

export type SnapshotScanCursor = {
  collection: string;
  id: string;
};

export type LeaseHandle = {
  token: string;
  purpose: MaintenancePurpose;
  expiresAt: number;
};

export type SnapshotCollectionDescriptor = {
  name: string;
  currentSchemaVersion: number;
  baseSchemaVersion: number;
};

export type SnapshotUniqueConstraint = {
  collection: string;
  name: string;
  valueKey: string;
  documentId: string;
};

export type SnapshotPreparedDocument = {
  document: SnapshotStoredDocument;
  uniqueConstraints: readonly SnapshotUniqueConstraint[];
};

export type SnapshotSeed = SnapshotPreparedDocument;

export type SnapshotLifecycle = {
  listCollections(): readonly SnapshotCollectionDescriptor[];
  prepareRestoredDocument(document: SnapshotStoredDocument): Promise<SnapshotPreparedDocument>;
  prepareSeeds(): Promise<readonly SnapshotSeed[]>;
};
