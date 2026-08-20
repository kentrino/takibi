type AttributeKeyTree<T, Prefix extends string> = {
  readonly [Key in keyof T]: T[Key] extends object
    ? AttributeKeyTree<T[Key], `${Prefix}.${Key & string}`>
    : `${Prefix}.${Key & string}`;
};

const takibiAttributes = {
  action: {
    name: "takibi.action.name",
    scope: "takibi.action.scope",
  },
  collection: {
    name: "takibi.collection.name",
  },
  document: {
    id: "takibi.document.id",
  },
  operation: {
    name: "takibi.operation.name",
  },
  storage: {
    operation: "takibi.storage.operation",
  },
} as const;

export const TAKIBI_ATTR = takibiAttributes satisfies AttributeKeyTree<
  typeof takibiAttributes,
  "takibi"
>;
