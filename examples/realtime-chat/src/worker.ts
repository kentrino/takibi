import { ChatRoom, chatHandler, type ChatEnv } from "./handler.ts";
import { roomFromApiPath } from "./shared.ts";

export { ChatRoom };

export default {
  async fetch(request: Request, env: ChatEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const room = roomFromApiPath(url.pathname);
    if (!room) return Response.json({ error: "Unknown chat room" }, { status: 404 });

    const result = await chatHandler.handle(request, {
      prefix: `/api/${room}`,
      context: { env, room },
    });
    return result.matched
      ? result.response
      : Response.json({ error: "Unknown API route" }, { status: 404 });
  },
} satisfies ExportedHandler<ChatEnv>;
