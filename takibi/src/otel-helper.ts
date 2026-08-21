import type { SpanAttributes } from "./tracing";

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

export const TAKIBI_SPAN = {
  action: "takibi.action",
  executor: "takibi.executor",
  policy: "takibi.policy",
  request: "takibi.request",
  resolve: "takibi.resolve",
  schema: "takibi.schema",
  storage: "takibi.storage",
  wire: "takibi.wire",
} as const;

export function actionSpanAttributes(name: string, scope: string): SpanAttributes {
  return {
    [TAKIBI_ATTR.action.name]: name,
    [TAKIBI_ATTR.action.scope]: scope,
  };
}

export function collectionSpanAttributes(
  collection: string,
  operation: string,
  id?: string,
): SpanAttributes {
  return {
    [TAKIBI_ATTR.collection.name]: collection,
    [TAKIBI_ATTR.operation.name]: operation,
    ...(id === undefined ? {} : { [TAKIBI_ATTR.document.id]: id }),
  };
}

export function invocationSpanAttributes(
  invocation:
    | { kind: "action"; name: string; scope: string }
    | { kind: "collection"; collection: string; operation: string; id?: string },
): SpanAttributes {
  return invocation.kind === "action"
    ? actionSpanAttributes(invocation.name, invocation.scope)
    : collectionSpanAttributes(invocation.collection, invocation.operation, invocation.id);
}

export function storageSpanAttributes(
  operation: string,
  collection?: string,
  id?: string,
): SpanAttributes {
  return {
    [TAKIBI_ATTR.storage.operation]: operation,
    ...(collection === undefined ? {} : { [TAKIBI_ATTR.collection.name]: collection }),
    ...(id === undefined ? {} : { [TAKIBI_ATTR.document.id]: id }),
  };
}
