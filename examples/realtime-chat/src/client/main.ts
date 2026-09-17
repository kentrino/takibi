import type { InferCollectionDoc, InferHandlerCollections } from "takibi";
import { createWatchClient, type WatchClientOf } from "takibi/watch";
import type { ChatHandler } from "../handler.ts";
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_WATCH_LIMIT,
  ROOMS,
  chronologicalSnapshot,
  connectionPresentation,
  normalizeMessageBody,
  shouldClearComposer,
  type Room,
} from "../shared.ts";

type Message = InferCollectionDoc<InferHandlerCollections<ChatHandler>["messages"]>;
type ChatClient = WatchClientOf<ChatHandler>;
type MessageSubscription = ReturnType<ChatClient["messages"]["watch"]>;
type Person = "Aさん" | "Bさん";

const roomSelect = requireElement<HTMLSelectElement>("room");
const grid = requireElement<HTMLDivElement>("chat-grid");

function requireElement<T>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}

function selectedRoom(): Room {
  const value = roomSelect.value;
  return ROOMS.includes(value as Room) ? (value as Room) : "lobby";
}

class ChatPane {
  private generation = 0;
  private subscription: MessageSubscription | undefined;
  private client: ChatClient | undefined;
  private readonly list = document.createElement("ol");
  private readonly status = document.createElement("span");
  private readonly statusDot = document.createElement("span");
  private readonly retry = document.createElement("button");
  private readonly count = document.createElement("p");
  private readonly empty = document.createElement("p");
  private readonly form = document.createElement("form");
  private readonly body = document.createElement("textarea");
  private readonly error = document.createElement("p");
  private readonly characterCount = document.createElement("span");
  private readonly send = document.createElement("button");

  constructor(private readonly person: Person) {
    const panel = document.createElement("section");
    const heading = document.createElement("div");
    const identity = document.createElement("div");
    const avatar = document.createElement("span");
    const identityText = document.createElement("div");
    const label = document.createElement("p");
    const name = document.createElement("h2");
    const connection = document.createElement("div");
    const composeFooter = document.createElement("div");

    panel.className = "chat-panel";
    panel.dataset.pane = this.person;
    heading.className = "room-heading";
    identity.className = "pane-identity";
    avatar.className = `person-avatar person-${this.person === "Aさん" ? "a" : "b"}`;
    avatar.textContent = this.person.slice(0, 1);
    label.className = "eyebrow";
    label.textContent = "CHATTING AS";
    name.textContent = this.person;
    connection.className = "connection";
    connection.setAttribute("aria-live", "polite");
    this.statusDot.className = "status-dot";
    this.retry.className = "retry";
    this.retry.type = "button";
    this.retry.textContent = "Retry";
    this.retry.hidden = true;
    this.count.className = "message-count";
    this.list.className = "messages";
    this.list.dataset.messages = this.person;
    this.list.ariaLive = "polite";
    this.list.ariaBusy = "true";
    this.empty.className = "empty";
    this.empty.textContent = "No messages yet. Start the fire.";
    this.empty.hidden = true;
    this.body.rows = 2;
    this.body.maxLength = MESSAGE_BODY_MAX_LENGTH;
    this.body.placeholder = `Message as ${this.person}…`;
    this.body.setAttribute("aria-label", `Message as ${this.person}`);
    composeFooter.className = "compose-footer";
    this.error.setAttribute("role", "alert");
    this.error.className = "form-error";
    this.characterCount.textContent = `0 / ${MESSAGE_BODY_MAX_LENGTH}`;
    this.characterCount.className = "character-count";
    this.send.type = "submit";
    this.send.textContent = "Send ↗";

    identityText.appendChild(label);
    identityText.appendChild(name);
    identity.appendChild(avatar);
    identity.appendChild(identityText);
    connection.appendChild(this.statusDot);
    connection.appendChild(this.status);
    connection.appendChild(this.retry);
    heading.appendChild(identity);
    heading.appendChild(connection);
    composeFooter.appendChild(this.error);
    composeFooter.appendChild(this.characterCount);
    composeFooter.appendChild(this.send);
    this.form.appendChild(this.body);
    this.form.appendChild(composeFooter);
    panel.appendChild(heading);
    panel.appendChild(this.count);
    panel.appendChild(this.list);
    panel.appendChild(this.empty);
    panel.appendChild(this.form);
    grid.appendChild(panel);

    this.retry.addEventListener("click", () => this.connect());
    this.body.addEventListener("input", () => {
      this.characterCount.textContent = `${this.body.value.length} / ${MESSAGE_BODY_MAX_LENGTH}`;
      this.error.textContent = "";
    });
    this.form.addEventListener("submit", (event) => this.submit(event));
  }

  connect(): void {
    const token = ++this.generation;
    this.subscription?.unsubscribe();
    const client = createWatchClient<ChatHandler>(`${location.origin}/api/${selectedRoom()}`);
    this.client = client;
    this.send.disabled = false;
    this.list.replaceChildren();
    this.list.ariaBusy = "true";
    this.count.textContent = "Waiting for messages…";
    this.empty.hidden = true;
    this.setConnection("connecting");
    this.error.textContent = "";
    const subscription = client.messages.watch(
      {
        index: "byCreatedAt",
        orderBy: (query) => query.createdAt.desc(),
        limit: MESSAGE_WATCH_LIMIT,
      },
      {
        next: ({ items }) => {
          if (this.generation === token) this.render(items);
        },
        state: (state) => {
          if (this.generation === token) this.setConnection(state);
        },
      },
    );
    this.subscription = subscription;
    void subscription.closed.then((outcome) => {
      if (this.generation === token && outcome.reason !== "unsubscribed") {
        this.setConnection("disconnected");
      }
    });
  }

  disconnect(): void {
    this.generation += 1;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  private setConnection(state: Parameters<typeof connectionPresentation>[0]): void {
    const presentation = connectionPresentation(state);
    this.status.textContent = presentation.label;
    this.statusDot.dataset.state = presentation.kind;
    this.retry.hidden = presentation.kind !== "terminal";
  }

  private render(items: Message[]): void {
    this.list.replaceChildren();
    for (const message of chronologicalSnapshot(items)) {
      const item = document.createElement("li");
      const bubble = document.createElement("div");
      const metadata = document.createElement("div");
      const author = document.createElement("strong");
      const time = document.createElement("time");
      const body = document.createElement("p");
      const own = message.displayName === this.person;
      item.className = own ? "own" : "other";
      bubble.className = "message-bubble";
      metadata.className = "message-meta";
      author.textContent = own ? "You" : message.displayName;
      time.dateTime = message.createdAt;
      time.textContent = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(message.createdAt));
      body.textContent = message.body;
      metadata.appendChild(author);
      metadata.appendChild(time);
      bubble.appendChild(metadata);
      bubble.appendChild(body);
      item.appendChild(bubble);
      this.list.appendChild(item);
    }
    this.list.ariaBusy = "false";
    this.empty.hidden = items.length !== 0;
    this.count.textContent = `${items.length} message${items.length === 1 ? "" : "s"} · latest ${MESSAGE_WATCH_LIMIT}`;
    this.list.scrollTop = this.list.scrollHeight;
  }

  private submit(event: SubmitEvent): void {
    event.preventDefault();
    if (this.send.disabled) return;
    const submittedDraft = this.body.value;
    const body = normalizeMessageBody(submittedDraft);
    if (!body) {
      this.error.textContent = `Enter a message (1–${MESSAGE_BODY_MAX_LENGTH} characters).`;
      this.body.focus();
      return;
    }
    const token = this.generation;
    const client = this.client;
    if (!client) return;
    this.send.disabled = true;
    this.error.textContent = "";
    void client.messages
      .add({ displayName: this.person, body })
      .then((result) => {
        if (this.generation !== token) return;
        if (!result.ok) this.error.textContent = result.error.message;
        else if (shouldClearComposer(this.body.value, submittedDraft)) {
          this.body.value = "";
          this.characterCount.textContent = `0 / ${MESSAGE_BODY_MAX_LENGTH}`;
          this.body.focus();
        }
      })
      .catch(() => {
        if (this.generation === token)
          this.error.textContent = "Message failed to send. Try again.";
      })
      .finally(() => {
        if (this.generation === token) this.send.disabled = false;
      });
  }
}

const panes = [new ChatPane("Aさん"), new ChatPane("Bさん")];
const reconnectAll = () => panes.forEach((pane) => pane.connect());
roomSelect.addEventListener("change", reconnectAll);
window.addEventListener("beforeunload", () => panes.forEach((pane) => pane.disconnect()));
reconnectAll();
