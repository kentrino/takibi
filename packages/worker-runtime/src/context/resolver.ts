// Kept apart from ./types, which also describes the Durable Object class:
// the platform-neutral tenant runtime reaches these types through the watch
// upgrade and must not depend on Cloudflare types.

export type ContextResolverInput<TInitial = Record<string, never>> = {
  request: Request;
  context: TInitial;
};

export type ContextResolver<TCtx extends object, TInitial = Record<string, never>> = (
  input: ContextResolverInput<TInitial>,
) => TCtx | Promise<TCtx>;
