import { useEffect, useRef } from "hono/jsx";
import { chronologicalSnapshot, MESSAGE_WATCH_LIMIT } from "../shared.ts";
import { MessageItem } from "./message-item.tsx";
import type { Message, Person } from "./types.ts";

export function MessageList(props: { person: Person; messages: Message[]; busy: boolean }) {
  const { person, messages, busy } = props;
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  return (
    <>
      <p class="m-0 px-5 pt-[9px] text-right text-[10px] text-count">
        {busy
          ? "Waiting for messages…"
          : `${messages.length} message${messages.length === 1 ? "" : "s"} · latest ${MESSAGE_WATCH_LIMIT}`}
      </p>
      <ol
        ref={listRef}
        class="m-0 h-[min(52vh,480px)] list-none overflow-y-auto px-[26px] py-[22px] max-[580px]:h-[50vh] max-[580px]:px-[18px]"
        data-messages={person}
        aria-live="polite"
        aria-busy={busy ? "true" : "false"}
      >
        {chronologicalSnapshot(messages).map((message) => (
          <MessageItem key={message.id} message={message} own={message.displayName === person} />
        ))}
      </ol>
      {busy || messages.length !== 0 ? null : (
        <p class="m-0 h-20 px-[26px] py-[26px] text-center text-empty">
          No messages yet. Start the fire.
        </p>
      )}
    </>
  );
}
