import type { InferCollectionDoc, InferHandlerCollections } from "takibi";
import type { WatchClientOf, WatchState } from "takibi/watch";
import type { ChatHandler } from "../handler.ts";

export type Message = InferCollectionDoc<InferHandlerCollections<ChatHandler>["messages"]>;
export type ChatClient = WatchClientOf<ChatHandler>;
export type MessageSubscription = ReturnType<ChatClient["messages"]["watch"]>;
export const PEOPLE = ["Alice", "Bob"] as const;
export type Person = (typeof PEOPLE)[number];
export type ConnectionState = WatchState | "disconnected";
