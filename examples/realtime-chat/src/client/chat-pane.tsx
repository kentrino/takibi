import { connectionPresentation, type Room } from "../shared.ts";
import { Composer } from "./composer.tsx";
import { MessageList } from "./message-list.tsx";
import type { Person } from "./types.ts";
import { useChat } from "./use-chat.ts";

export function ChatPane(props: { person: Person; room: Room }) {
  const { person, room } = props;
  const chat = useChat(person, room);
  const presentation = connectionPresentation(chat.connection);
  const tone = person === "Alice" ? "a" : "b";

  return (
    <section
      class="overflow-hidden rounded-[18px] border border-line bg-panel shadow-[0_20px_55px_#5e432316]"
      data-pane={person}
    >
      <div class="flex items-center justify-between border-b border-heading-line px-5 pt-[18px] pb-3.5 max-[580px]:flex-col max-[580px]:items-start max-[580px]:gap-2">
        <div class="flex items-center gap-2.5">
          <span
            class={`grid size-9 place-items-center rounded-xl text-[13px] font-extrabold ${
              tone === "a" ? "bg-person-a-bg text-person-a" : "bg-person-b-bg text-person-b"
            }`}
          >
            {person.slice(0, 1)}
          </span>
          <div>
            <p class="mb-1.5 text-[10px] font-extrabold tracking-[0.19em] text-eyebrow">
              CHATTING AS
            </p>
            <h2 class="m-0 font-serif text-2xl">{person}</h2>
          </div>
        </div>
        <div
          class="ml-auto flex items-center gap-2 text-[13px] whitespace-nowrap text-muted max-[580px]:ml-0"
          aria-live="polite"
        >
          <span
            class="size-2 rounded-full bg-dot-pending shadow-[0_0_0_4px_#d49a4322] data-[state=open]:bg-dot-open data-[state=open]:shadow-[0_0_0_4px_#4c9a6922] data-[state=terminal]:bg-dot-terminal data-[state=terminal]:shadow-[0_0_0_4px_#b34d4322]"
            data-state={presentation.kind}
          />
          <span>{presentation.label}</span>
          {presentation.kind === "terminal" ? (
            <button
              class="cursor-pointer border-0 bg-transparent p-[3px_7px] text-retry underline"
              type="button"
              onClick={chat.reconnect}
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
      <MessageList person={person} messages={chat.messages} busy={chat.busy} />
      <Composer
        person={person}
        sending={chat.sending}
        sendError={chat.sendError}
        onSend={chat.post}
        onDraftChange={chat.clearSendError}
      />
    </section>
  );
}
