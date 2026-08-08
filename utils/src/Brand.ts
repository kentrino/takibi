export type Brand<T, BrandName extends string> = T & { readonly __brand: BrandName };
