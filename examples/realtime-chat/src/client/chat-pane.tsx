import { useEffect, useRef, useState } from "hono/jsx";
import { createWatchClient } from "takibi/watch";
import type { ChatHandler } from "../handler.ts";
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_WATCH_LIMIT,
  connectionPresentation,
  normalizeMessageBody,
  shouldClearComposer,
  type Room,
} from "../shared.ts";
import { Composer } from "./composer.tsx";
import { MessageList } from "./message-list.tsx";
import type { ChatClient, ConnectionState, Message, MessageSubscription, Person } from "./types.ts";

export function ChatPane(props: { person: Person; room: Room }) {
  const { person, room } = props;
  const generation = useRef(0);
  const subscription = useRef<MessageSubscription>(undefined);
  const client = useRef<ChatClient>(undefined);
  const draftRef = useRef("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const connectRef = useRef(() => {});
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const presentation = connectionPresentation(connection);
  const tone = person === "Alice" ? "a" : "b";

  draftRef.current = draft;

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
      setError("");
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

  function submit(event: Event): void {
    event.preventDefault();
    if (sending) return;
    const submittedDraft = draftRef.current;
    const body = normalizeMessageBody(submittedDraft);
    if (!body) {
      setError(`Enter a message (1–${MESSAGE_BODY_MAX_LENGTH} characters).`);
      bodyRef.current?.focus();
      return;
    }
    const token = generation.current;
    const active = client.current;
    if (!active) return;
    setSending(true);
    setError("");
    void active.messages
      .add({ displayName: person, body })
      .then((result) => {
        if (generation.current !== token) return;
        if (!result.ok) setError(result.error.message);
        else if (shouldClearComposer(draftRef.current, submittedDraft)) {
          setDraft("");
          bodyRef.current?.focus();
        }
      })
      .catch(() => {
        if (generation.current === token) setError("Message failed to send. Try again.");
      })
      .finally(() => {
        if (generation.current === token) setSending(false);
      });
  }

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
              onClick={() => connectRef.current()}
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
      <MessageList person={person} messages={messages} busy={busy} />
      <Composer
        person={person}
        draft={draft}
        error={error}
        sending={sending}
        bodyRef={bodyRef}
        onDraftChange={(value) => {
          setDraft(value);
          setError("");
        }}
        onSubmit={submit}
      />
    </section>
  );
}
