import { takibiServer, type TakibiHttpHandler } from "@takibi/hono-adapter";
import { Hono, type Context } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { chatHandler, type ChatEnv, type RequestContext } from "./handler.ts";
import { HomePage } from "./page.tsx";
import { ROOMS } from "./shared.ts";

export type AppEnv = { Bindings: ChatEnv };

const favicon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23e45d2b'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-size='16' fill='%23fff8ec'%3E火%3C/text%3E%3C/svg%3E";

export function createChatApp(handler: TakibiHttpHandler<RequestContext> = chatHandler) {
  const app = new Hono<AppEnv>();
  const renderPage = jsxRenderer(({ children }) => (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
          name="description"
          content="A public realtime chat powered by Takibi watch snapshots."
        />
        <title>Takibi Fireside</title>
        <link rel="icon" href={favicon} />
        <link rel="stylesheet" href="/main.css" />
      </head>
      <body class="m-0 min-h-dvh min-w-[320px] bg-paper font-sans text-ink antialiased [font-synthesis:none]">
        {children}
        <script type="module" src="/main.js" />
      </body>
    </html>
  ));
  app.get("/", renderPage, (c) => c.render(<HomePage />));
  for (const room of ROOMS) {
    app.use(
      `/api/${room}/*`,
      takibiServer({
        handler,
        createContext: (c: Context<AppEnv>) => ({ env: c.env, room }),
      }),
    );
    app.all(`/api/${room}/*`, (c) => c.json({ error: "Unknown API route" }, 404));
  }
  app.all("/api/*", (c) => c.json({ error: "Unknown chat room" }, 404));
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

export const app = createChatApp();
