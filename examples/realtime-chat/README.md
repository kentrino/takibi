# Takibi realtime chat

A runnable public chat showing Takibi's `createWatchClient` snapshots across two
independent browser clients. The two panes simulate **Alice** and **Bob**;
there is intentionally no authentication or authorization.

## Try the two panes

From the repository root:

```sh
pnpm install
pnpm --filter @takibi/realtime-chat build
pnpm --filter @takibi/realtime-chat dev
```

Open the URL printed by Wrangler (normally <http://localhost:8787>).

1. Leave the shared room on **Lobby**.
2. Send a message from the left pane (Alice). It should appear on the right as
   well, right-aligned for Alice and left-aligned for Bob.
3. Reply from the right pane (Bob). Alice's pane should receive it without a
   refresh.
4. Switch the shared room to **Help desk** or **Random**. Both panes clear, then
   only messages for that room appear. Switching back to Lobby restores its
   earlier messages.

For checks and tests:

```sh
pnpm --filter @takibi/realtime-chat check
pnpm --filter @takibi/realtime-chat test
```

## How it is put together

Hono serves the page with `jsxRenderer` and mounts `/api/:room` through
`takibiServer`. Tailwind styles the server-rendered shell and the `hono/jsx/dom`
panes. The Worker uses that room segment as the Durable Object name and lets
Takibi handle collection paths below the prefix. The demo selector offers
`lobby`, `help`, and `random`; any other room name is a separate object. HTTP
`messages.send` writes (with a
server-assigned id) and WebSocket `messages.watch` share the same-origin
endpoint. The declared `byCreatedAt`
index returns the newest 50 messages; the UI reverses each full snapshot for
chronological display. Wrangler runs the Worker first, then serves the Vite
build for `/main.js` and `/main.css`.

The browser derives message and subscription types from `ChatHandler`. Connection
callbacks use the SDK's `WatchState`; terminal `closed` outcomes become the UI's
`disconnected` state. A generation guard prevents the previous room's completion
from updating the current pane.

Tests cover validation and list ordering with the SQLite backend, and call the
Hono app with a namespace test double to verify named-object selection.
The two-store test checks independent SQLite stores; it does not prove Cloudflare
object isolation. Actual WebSocket delivery and room isolation can be checked with
the two-pane walkthrough above. See the SDK's
[watch guide](../../packages/takibi/README.md#watch-list-snapshots) for lifecycle,
typing, routing, and testing contracts.

## Public demo limits

This is a public local demo. Anyone who can reach it can read and write any
room. It has no identity, moderation, rate limiting, deletion UI, or
production retention policy. Each pane shows at most the latest 50 messages. A
room keeps its Durable Object data between local server restarts until
Wrangler's local state is removed.

See [DESIGN.md](./DESIGN.md) for the design decisions.
