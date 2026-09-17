import { chatHandler } from "./handler.ts";
import type { ChatEnv } from "./handler.ts";
import { routeWorkerPath } from "./shared.ts";

type RequestHandler = Pick<typeof chatHandler, "handle">;

export async function handleRequest(
  request: Request,
  env: ChatEnv,
  handler: RequestHandler = chatHandler,
): Promise<Response> {
  const url = new URL(request.url);
  const route = routeWorkerPath(url.pathname);
  if (route === "assets") return env.ASSETS.fetch(request);
  if (route === "unknown-room") {
    return Response.json({ error: "Unknown chat room" }, { status: 404 });
  }

  const result = await handler.handle(request, {
    prefix: `/api/${route.room}`,
    context: { env, room: route.room },
  });
  return result.matched
    ? result.response
    : Response.json({ error: "Unknown API route" }, { status: 404 });
}
