import { Hono } from "hono";
import { NotFoundError } from "@takibi/takibi-api";
import {
  decodePublicHttp,
  decodePublicRoute,
  matchesPublicPrefix,
  rawPathSegments,
  readRequestJson,
  type PublicRequest,
} from "../http";
import type { HandleOptions, HandleResult } from "./types";

export type ServeCall<TInitial = unknown> = (
  request: Request,
  initial: TInitial,
  decode: () => Promise<PublicRequest>,
) => Promise<Response>;

/** The two HTTP entry points share a Call; Hono alone owns route matching. */
export type InitialHttpHandler<TInitial> = {
  handle(request: Request, options: HandleOptions<TInitial>): Promise<HandleResult>;
};

/** This entry always receives the initial value from its caller. */
export function createInitialHttpHandler<TInitial>(
  serve: ServeCall<TInitial>,
): InitialHttpHandler<TInitial> {
  return {
    async handle(request, options) {
      if (!matchesPublicPrefix(new URL(request.url).pathname, options.prefix)) {
        return { matched: false };
      }
      const response = await serve(request, options.context, () =>
        decodePublicHttp(request, options.prefix),
      );
      return { matched: true, response };
    },
  };
}

/** Only a resolver accepting an empty initial value can enter through Hono. */
export function createHttpHandler(serve: ServeCall<Record<string, never>>) {
  const app = new Hono<{ Bindings: Record<string, unknown> }>();
  const mount = (path: string, segmentCount: number) => {
    app.all(path, async (c) => {
      const response = await serve(c.req.raw, {}, () => {
        const url = new URL(c.req.url);
        // Hono params decode too early: action ids split on the last raw colon.
        return decodePublicRoute(
          c.req.method,
          rawPathSegments(url.pathname, segmentCount),
          url.searchParams,
          () => readRequestJson(c.req.raw),
        );
      });
      return c.newResponse(response.body, response);
    });
  };
  mount("/_batch", 1);
  mount("/:collection", 1);
  mount("/:collection/:id", 2);
  app.all("/:collection/:id/*", async (c) => {
    const response = await serve(c.req.raw, {}, async () => {
      throw new NotFoundError();
    });
    return c.newResponse(response.body, response);
  });
  app.all("/", async (c) => {
    const response = await serve(c.req.raw, {}, () => decodePublicHttp(c.req.raw));
    return c.newResponse(response.body, response);
  });

  const initialHandler = createInitialHttpHandler(serve);
  return Object.assign(app, {
    handle(
      request: Request,
      options: { prefix?: string; context?: Record<string, never> },
    ): Promise<HandleResult> {
      return initialHandler.handle(request, { ...options, context: options.context ?? {} });
    },
  });
}
