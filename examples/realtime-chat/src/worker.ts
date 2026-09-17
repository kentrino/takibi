import { ChatRoom } from "./handler.ts";
import type { ChatEnv } from "./handler.ts";
import { handleRequest } from "./fetch.ts";

export { ChatRoom };

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<ChatEnv>;
