import { Hono, type Context, type Env } from "hono";
import { basePath } from "hono/route";
import type { HandleOptions, HandleResult } from "takibi";
import { stripPath } from "./strip-path";

export type TakibiHttpHandler<TInput> = {
  handle: (request: Request, options: HandleOptions<TInput>) => Promise<HandleResult>;
};

/** Mount the returned Hono app with `app.route(prefix, server)`. */
export function takibiServer<TInput, TEnv extends Env>(options: {
  handler: TakibiHttpHandler<TInput>;
  createContext: (c: Context<TEnv>) => NoInfer<TInput> | Promise<NoInfer<TInput>>;
}): Hono<TEnv> {
  const app = new Hono<TEnv>();
  app.use("*", async (c, next) => {
    const base = basePath(c);
    const context = await options.createContext(c);
    const result = await options.handler.handle(c.req.raw, {
      stripPrefix: (path) => stripPath({ base, path }),
      context,
    });
    if (result.matched) {
      // Hono cannot reconstruct 101 Switching Protocols from a WebSocket upgrade.
      if (result.response.status < 200) return result.response;
      return c.newResponse(result.response.body, result.response);
    }
    await next();
  });
  return app;
}
