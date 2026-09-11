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
  /** This property carries types. Do not read it as runtime application data. */
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

/** Read the internal runtime representation without exposing phantom types as values. */
export function readTakibiBrand<TBrand extends TakibiBrandRecord>(
  target: TakibiBrandCarrier<TBrand>,
): TakibiBrandRecord<null, null, TBrand["collections"], TBrand["actions"], null> {
  const { collections, actions } = target[TAKIBI_BRAND];
  return {
    context: null,
    initial: null,
    collections,
    actions,
    services: null,
  };
}
