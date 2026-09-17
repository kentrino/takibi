# Takibi realtime chat

A runnable public chat showing Takibi's `createWatchClient` snapshots across two
independent browser clients. The two panes simulate **Aさん** and **Bさん**;
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
2. Send a message from the left pane (Aさん). It should appear on the right as
   well, right-aligned for A and left-aligned for B.
3. Reply from the right pane (Bさん). Aさんの pane should receive it without a
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

The Worker validates a preset room in `/api/:room` (`lobby`, `help`, `random`),
routes it to one named Durable Object, and mounts the Takibi handler below that
prefix. HTTP `messages.add` writes and WebSocket `messages.watch` share the
same-origin endpoint. The declared `byCreatedAt` index returns the newest 50
messages; the UI reverses each full snapshot for chronological display.
Wrangler serves the Vite build as static assets and runs the Worker first for
`/api/*`.

## Public demo limits

This is a public local demo. Anyone who can reach it can read and write every
preset room. It has no identity, moderation, rate limiting, deletion UI, or
production retention policy. Each pane shows at most the latest 50 messages. A
room keeps its Durable Object data between local server restarts until
Wrangler's local state is removed.

See [DESIGN.md](./DESIGN.md) for the design decisions.
