export type Narrows<From, To> = {
  readonly apply: (value: From) => To;
};

export function narrows<From, To>(apply: (value: From) => To): Narrows<From, To> {
  return { apply };
}
