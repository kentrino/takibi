import { createTakibi, fullAccess } from "takibi";
import { z } from "zod";
import { DISPLAY_NAME_MAX_LENGTH, MESSAGE_BODY_MAX_LENGTH, type Room } from "./shared.ts";

export type ChatEnv = {
  CHAT_ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
};

type RequestContext = { env: ChatEnv; room: Room };

const app = createTakibi<RequestContext>()({
  resolve: ({ context }) => ({ room: context.room }),
  stub: ({ context, resolved }) =>
    context.env.CHAT_ROOMS.get(context.env.CHAT_ROOMS.idFromName(resolved.room)),
}).defineCollections({
  messages: {
    schema: z.object({
      displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH),
      body: z.string().trim().min(1).max(MESSAGE_BODY_MAX_LENGTH),
    }),
    indexes: { byCreatedAt: ["createdAt"] },
    accessPolicy: fullAccess,
  },
});

export const chatHandler = app.actions({});
export type ChatHandler = typeof chatHandler;
export class ChatRoom extends chatHandler.DurableObject {}
