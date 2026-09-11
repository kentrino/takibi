import type {
  OrderBuilder,
  OrderExpr,
  QueryBuilder,
  QueryExpr,
  QueryScalar,
} from "@takibi/takibi-shared-types";

type DefaultListDocument = {
  id: string;
  createdAt: string;
  updatedAt: string;
} & Record<string, QueryScalar>;

type UnindexedListOptions<TDoc> = {
  limit?: number;
  cursor?: string;
  where?: (query: QueryBuilder<TDoc>) => QueryExpr;
};

type IndexedListOptions<TDoc, TIndexes extends Record<string, readonly string[]>> = {
  [K in keyof TIndexes & string]: {
    index: K;
    limit?: number;
    cursor?: string;
    where?: (query: QueryBuilder<TDoc>) => QueryExpr;
    orderBy?: (query: OrderBuilder<TIndexes[K]>) => OrderExpr;
  };
}[keyof TIndexes & string];

export type ListOptions<
  TDoc = DefaultListDocument,
  TIndexes extends Record<string, readonly string[]> = Record<string, never>,
> = [keyof TIndexes] extends [never]
  ? UnindexedListOptions<TDoc>
  :
      | (UnindexedListOptions<TDoc> & { index?: never; orderBy?: never })
      | IndexedListOptions<TDoc, TIndexes>;
