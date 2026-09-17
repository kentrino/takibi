import { useEffect, useRef, useState } from "hono/jsx";
import { render } from "hono/jsx/dom";
import "./style.css";
import type { InferCollectionDoc, InferHandlerCollections } from "takibi";
import { createWatchClient, type WatchClientOf } from "takibi/watch";
import type { ChatHandler } from "../handler.ts";
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_WATCH_LIMIT,
  chronologicalSnapshot,
  connectionPresentation,
  isRoom,
  normalizeMessageBody,
  shouldClearComposer,
  type Room,
} from "../shared.ts";

type Message = InferCollectionDoc<InferHandlerCollections<ChatHandler>["messages"]>;
type ChatClient = WatchClientOf<ChatHandler>;
type MessageSubscription = ReturnType<ChatClient["messages"]["watch"]>;
type Person = "Aさん" | "Bさん";
type ConnectionState = Parameters<typeof connectionPresentation>[0];

const roomSelect = requireElement<HTMLSelectElement>("room");
const grid = requireElement<HTMLDivElement>("chat-grid");

function requireElement<T>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}

function selectedRoom(): Room {
  return isRoom(roomSelect.value) ? roomSelect.value : "lobby";
}

function ChatPane(props: { person: Person; room: Room }) {
  const { person, room } = props;
  const generation = useRef(0);
  const subscription = useRef<MessageSubscription>(undefined);
  const client = useRef<ChatClient>(undefined);
  const draftRef = useRef("");
  const listRef = useRef<HTMLOListElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const connectRef = useRef(() => {});
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const presentation = connectionPresentation(connection);
  const tone = person === "Aさん" ? "a" : "b";

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

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

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
        {chronologicalSnapshot(messages).map((message) => {
          const own = message.displayName === person;
          return (
            <li key={message.id} class={`flex py-[7px] ${own ? "justify-end" : ""}`}>
              <div
                class={`max-w-[84%] px-[11px] py-[9px] ${
                  own
                    ? "rounded-[13px_4px_13px_13px] bg-person-a-bg"
                    : "rounded-[4px_13px_13px_13px] bg-bubble"
                }`}
              >
                <div class="mb-[3px] flex items-baseline gap-[9px]">
                  <strong class="text-[13px]">{own ? "You" : message.displayName}</strong>
                  <time class="text-[10px] text-meta" dateTime={message.createdAt}>
                    {new Intl.DateTimeFormat(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(new Date(message.createdAt))}
                  </time>
                </div>
                <p class="m-0 text-sm leading-[1.48] whitespace-pre-wrap text-body [overflow-wrap:anywhere]">
                  {message.body}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {busy || messages.length !== 0 ? null : (
        <p class="m-0 h-20 px-[26px] py-[26px] text-center text-empty">
          No messages yet. Start the fire.
        </p>
      )}
      <form
        class="mx-[22px] mb-[22px] rounded-[13px] border border-line bg-white"
        onSubmit={submit}
      >
        <textarea
          ref={bodyRef}
          class="block min-h-[70px] w-full resize-y border-0 bg-transparent px-[15px] pt-3.5 pb-1.5 text-select outline-none"
          rows={2}
          maxLength={MESSAGE_BODY_MAX_LENGTH}
          placeholder={`Message as ${person}…`}
          aria-label={`Message as ${person}`}
          value={draft}
          onInput={(event) => {
            if (event.target instanceof HTMLTextAreaElement) {
              setDraft(event.target.value);
              setError("");
            }
          }}
        />
        <div class="flex min-h-[47px] items-center gap-3 px-2 pt-1.5 pr-2 pb-2 pl-[15px]">
          <p class="m-0 flex-1 text-[11px] text-error" role="alert">
            {error}
          </p>
          <span class="text-[10px] text-meta">
            {draft.length} / {MESSAGE_BODY_MAX_LENGTH}
          </span>
          <button
            class="cursor-pointer rounded-[9px] border-0 bg-ember px-[15px] py-[9px] text-xs font-bold text-white disabled:cursor-wait disabled:opacity-55"
            type="submit"
            disabled={sending}
          >
            Send ↗
          </button>
        </div>
      </form>
    </section>
  );
}

function App() {
  const [room, setRoom] = useState<Room>(selectedRoom);
  useEffect(() => {
    const onChange = () => setRoom(selectedRoom());
    roomSelect.addEventListener("change", onChange);
    return () => roomSelect.removeEventListener("change", onChange);
  }, []);
  return (
    <>
      <ChatPane person="Aさん" room={room} />
      <ChatPane person="Bさん" room={room} />
    </>
  );
}

render(<App />, grid);
