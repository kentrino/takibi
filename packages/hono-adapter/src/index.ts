import type { Context, Env, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { HandleResult } from "takibi";

export type TakibiHttpHandler<TInput> = {
  handle: (
    request: Request,
    options: { prefix?: string; context: TInput },
  ) => Promise<HandleResult>;
};

/** Mount on a static prefix followed by /*, or on * at the root. */
export function takibiServer<TInput, TEnv extends Env>(options: {
  handler: TakibiHttpHandler<TInput>;
  createContext: (c: Context<TEnv>) => NoInfer<TInput> | Promise<NoInfer<TInput>>;
}): MiddlewareHandler<TEnv> {
  return async (c, next) => {
    const prefix = routePath(c).replace(/\/?\*$/, "");
    const context = await options.createContext(c);
    const result = await options.handler.handle(c.req.raw, { prefix, context });
    if (result.matched) {
      // Hono cannot reconstruct 101 Switching Protocols from a WebSocket upgrade.
      if (result.response.status < 200) return result.response;
      return c.newResponse(result.response.body, result.response);
    }
    await next();
  };
}
