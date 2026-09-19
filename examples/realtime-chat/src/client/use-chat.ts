import { useEffect, useRef, useState } from "hono/jsx";
import { createWatchClient } from "takibi/watch";
import type { ChatHandler } from "../handler.ts";
import { MESSAGE_WATCH_LIMIT, type Room } from "../shared.ts";
import type { ChatClient, ConnectionState, Message, MessageSubscription, Person } from "./types.ts";

/**
 * One pane's watch + send for a room.
 * Watch is the whole room, not this person. Person is only the displayName on post.
 *
 * `generation` is a stale-result token. Changing rooms (or Retry) increments it so
 * the previous watch callbacks and in-flight `messages.send` cannot update this pane.
 */
export function useChat(person: Person, room: Room) {
  const generation = useRef(0);
  const subscription = useRef<MessageSubscription>(undefined);
  const client = useRef<ChatClient>(undefined);
  const connectRef = useRef(() => {});
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  useEffect(() => {
    function connect(): void {
      const token = ++generation.current;
      subscription.current?.unsubscribe();
      const next = createWatchClient<ChatHandler>(`${location.origin}/api/${room}`);
      client.current = next;
      setSending(false);
      setMessages([]);
      setBusy(true);
      setConnection("connecting");
      setSendError("");
      const nextSubscription = next.messages.watch(
        {
          index: "byCreatedAt",
          orderBy: (query) => query.createdAt.desc(),
          limit: MESSAGE_WATCH_LIMIT,
        },
        {
          next: ({ items }) => {
            if (generation.current === token) {
              setMessages(items);
              setBusy(false);
            }
          },
          state: (state) => {
            if (generation.current === token) setConnection(state);
          },
        },
      );
      subscription.current = nextSubscription;
      void nextSubscription.closed.then((outcome) => {
        if (generation.current === token && outcome.reason !== "unsubscribed") {
          setConnection("disconnected");
        }
      });
    }

    connectRef.current = connect;
    connect();
    return () => {
      generation.current += 1;
      subscription.current?.unsubscribe();
      subscription.current = undefined;
    };
  }, [person, room]);

  async function post(body: string): Promise<"ok" | "error" | "stale"> {
    const token = generation.current;
    const active = client.current;
    if (!active) return "stale";
    setSending(true);
    setSendError("");
    try {
      const result = await active.messages.send({ displayName: person, body });
      if (generation.current !== token) return "stale";
      if (!result.ok) {
        setSendError(result.error.message);
        return "error";
      }
      return "ok";
    } catch {
      if (generation.current === token) setSendError("Message failed to send. Try again.");
      return "error";
    } finally {
      if (generation.current === token) setSending(false);
    }
  }

  return {
    messages,
    busy,
    connection,
    sending,
    sendError,
    post,
    reconnect: () => connectRef.current(),
    clearSendError: () => setSendError(""),
  };
}
