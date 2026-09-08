export type SqliteDurableObjectStorage = DurableObjectStorage & {
    close(): void;
};
export declare function createSqliteDurableObjectStorage(): SqliteDurableObjectStorage;
