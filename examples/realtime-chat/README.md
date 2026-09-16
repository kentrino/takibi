# Takibi realtime chat

A runnable public chat showing Takibi's `createWatchClient` snapshots across two
independent browser clients. The two panes simulate **Aさん** and **Bさん**;
there is intentionally no authentication or authorization.

The Worker validates a preset room in `/api/:room`, routes it to one named
Durable Object, and mounts the Takibi handler below that prefix. HTTP `add`
writes and WebSocket watches share the same-origin endpoint. The declared
`byCreatedAt` index returns the newest 50 messages; the UI reverses each full
snapshot for chronological display. Wrangler serves the Vite build as static
assets and runs the Worker first for `/api/*`.

From the repository root:

```sh
pnpm install
pnpm --filter @takibi/realtime-chat build
pnpm --filter @takibi/realtime-chat dev
```

Open the URL printed by Wrangler (normally <http://localhost:8787>). Choose a
room and send from either pane. For checks and tests:

```sh
pnpm --filter @takibi/realtime-chat check
pnpm --filter @takibi/realtime-chat test
```

This is a public local demo. Anyone who can reach it can read and write every
preset room. It has no identity, moderation, rate limiting, deletion UI, or
production retention policy. A room keeps its Durable Object data between local
server restarts until Wrangler's local state is removed.

See [DESIGN.md](./DESIGN.md) for the design decisions.
