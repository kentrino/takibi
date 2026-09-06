export type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Extracts keys whose value types are assignable to `TType`.
 *
 * `any` and `never` are excluded because they are assignable to every type
 * without describing a value that can safely be treated as `TType`.
 */
export type KeysMatching<TObject, TType> = {
  [TKey in keyof TObject]-?: IsAny<TObject[TKey]> extends true
    ? never
    : [TObject[TKey]] extends [never]
      ? never
      : [TObject[TKey]] extends [TType]
        ? TKey
        : never;
}[keyof TObject];

export type StringKeysMatching<TObject, TType> = Extract<KeysMatching<TObject, TType>, string>;

export type HasDuplicateTupleMember<TTuple extends readonly unknown[]> = TTuple extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Head extends Tail[number]
    ? true
    : HasDuplicateTupleMember<Tail>
  : false;

export type DistributiveOmit<TObject, TKeys extends PropertyKey> = TObject extends unknown
  ? Omit<TObject, TKeys>
  : never;

export type ForbidKeys<TObject, TKeys extends PropertyKey> =
  Extract<keyof TObject, TKeys> extends never
    ? unknown
    : { [TKey in Extract<keyof TObject, TKeys>]?: never };
