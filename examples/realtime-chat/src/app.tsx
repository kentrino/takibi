import { takibiServer, type TakibiHttpHandler } from "@takibi/hono-adapter";
import { Hono, type Context } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { Document } from "./document.tsx";
import { chatHandler, type ChatEnv, type RequestContext } from "./handler.ts";
import { HomePage } from "./page.tsx";

export type AppEnv = { Bindings: ChatEnv };

export function createChatApp(handler: TakibiHttpHandler<RequestContext> = chatHandler) {
  const app = new Hono<AppEnv>();
  app.get(
    "/",
    jsxRenderer(({ children }) => <Document>{children}</Document>),
    (c) => c.render(<HomePage />),
  );
  app.route(
    "/api/:room",
    takibiServer({
      handler,
      createContext: (c: Context<AppEnv, "/api/:room">) => ({
        env: c.env,
        room: c.req.param("room"),
      }),
    }),
  );
  app.all("/api/*", (c) => c.json({ error: "Unknown API route" }, 404));
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

export const app = createChatApp();
