import { createTakibi, fullAccess, read } from "takibi";
import { z } from "zod";
import { DISPLAY_NAME_MAX_LENGTH, MESSAGE_BODY_MAX_LENGTH, type Room } from "./shared.ts";

export type ChatEnv = {
  CHAT_ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
};

export type RequestContext = { env: ChatEnv; room: Room };

const messageFields = z.object({
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH),
  body: z.string().trim().min(1).max(MESSAGE_BODY_MAX_LENGTH),
});

const app = createTakibi<RequestContext>()({
  resolve: ({ context }) => ({ room: context.room }),
  stub: ({ context, resolved }) =>
    context.env.CHAT_ROOMS.get(context.env.CHAT_ROOMS.idFromName(resolved.room)),
}).defineCollections({
  messages: {
    schema: messageFields,
    indexes: { byCreatedAt: ["createdAt"] },
    accessPolicy: read,
  },
});

const messages = app.messages.actions((defineAction) => ({
  send: defineAction()
    .detached()
    .input(messageFields)
    .policy(fullAccess)
    .handler(async ({ input, $collection }) => {
      const message = await $collection.add(input, { id: crypto.randomUUID() });
      return { id: message.id };
    }),
}));

export const chatHandler = app.actions({ messages });
export type ChatHandler = typeof chatHandler;
export class ChatRoom extends chatHandler.DurableObject {}
