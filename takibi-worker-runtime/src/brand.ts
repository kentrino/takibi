export const TAKIBI_BRAND = "~takibi" as const;

export type TakibiBrandRecord<
  TContext = unknown,
  TInitial = unknown,
  TCollections = unknown,
  TActions = unknown,
  TServices = unknown,
> = {
  context: TContext;
  initial: TInitial;
  collections: TCollections;
  actions: TActions;
  services: TServices;
};

export type TakibiBrandCarrier<TBrand = TakibiBrandRecord> = {
  readonly [TAKIBI_BRAND]: TBrand;
};

/**
 * Attach the type-carrier brand as a hidden own property.
 *
 * The return type is what `typeof handler` and `createClient` read.
 * `context` / `initial` / `services` stay null; only collections and
 * actions are runtime values.
 */
export function assignTakibiBrand<
  T extends object,
  TCollections,
  TActions,
  TContext = null,
  TInitial = null,
  TServices = null,
>(
  target: T,
  definitions: {
    collections: TCollections;
    actions: TActions;
  },
): T &
  TakibiBrandCarrier<TakibiBrandRecord<TContext, TInitial, TCollections, TActions, TServices>> {
  const brand: TakibiBrandRecord<null, null, TCollections, TActions, null> = {
    context: null,
    initial: null,
    services: null,
    collections: definitions.collections,
    actions: definitions.actions,
  };
  Object.defineProperty(target, TAKIBI_BRAND, {
    value: brand,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return target as T &
    TakibiBrandCarrier<TakibiBrandRecord<TContext, TInitial, TCollections, TActions, TServices>>;
}

export function readTakibiBrand<TBrand>(target: TakibiBrandCarrier<TBrand>): TBrand {
  return target[TAKIBI_BRAND];
}
