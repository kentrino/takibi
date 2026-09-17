# Realtime chat example design

This example demonstrates Takibi's opt-in watch client with the smallest useful
Cloudflare Worker application around it.

- The Worker accepts only the public rooms `lobby`, `help`, and `random` at
  `/api/:room`. It validates that segment before selecting the Durable Object
  named for the room.
- One generated Takibi Durable Object stores each room. Messages use `fullAccess`
  because this is deliberately a public demo with no authentication or
  authorization.
- `messages.byCreatedAt` supports the descending, limited watch query. Each
  snapshot contains the newest 50 messages and the browser reverses it for
  chronological display.
- Two panes simulate `Aさん` and `Bさん` without identity or authentication.
  Each pane owns a `createWatchClient`, watch subscription, connection state,
  retry control, composer, and draft. A shared room selector makes realtime
  delivery visible side by side.
- Changing rooms unsubscribes both old watches before creating the next clients;
  every async callback and send is guarded by the pane's generation number.
- Vite builds a dependency-free browser UI. Wrangler serves those static assets
  and routes `/api/*` to the Worker on the same origin.

The UI owns connection and retry presentation, message validation, own/other
alignment, and draft retention. Takibi owns persistence, HTTP result envelopes,
snapshots, and WebSocket reconnection.
