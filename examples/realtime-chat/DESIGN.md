# Realtime chat example design

This example demonstrates Takibi's opt-in watch client with the smallest useful
Cloudflare Worker application around it.

- A Hono app owns HTTP. `jsxRenderer` serves the Fireside page. Tailwind styles
  both the server-rendered shell and the client panes. Each preset room mounts
  at `/api/:room/*` through `takibiServer`. Unknown rooms stay a Hono 404.
  Remaining paths fall through to Wrangler assets.
- The Worker accepts only the public rooms `lobby`, `help`, and `random`. It
  validates that segment before selecting the Durable Object named for the room.
- One generated Takibi Durable Object stores each room. Lists and watches are
  public `read`. Writes go through the detached `messages.send` action, which
  assigns the document id on the server. There is no authentication.
- `messages.byCreatedAt` supports the descending, limited watch query. Each
  snapshot contains the newest 50 messages and the browser reverses it for
  chronological display.
- Two panes simulate `Alice` and `Bob` without identity or authentication.
  Each pane owns a `createWatchClient`, watch subscription, connection state,
  retry control, composer, and draft. A shared room selector makes realtime
  delivery visible side by side.
- Changing rooms unsubscribes both old watches before creating the next clients.
  `generation` is a stale-result token: each connect increments it so the previous
  watch callbacks and in-flight `messages.send` cannot update the current pane.
  A successful send clears the composer only when the draft is unchanged, so a
  newer draft survives an in-flight request. Room changes re-enable Send even
  if the previous room still has a request in flight.
- Vite builds the `hono/jsx/dom` island and Tailwind CSS. Wrangler runs the
  Worker first so Hono can render `/` and `/api/*`, then serves those assets.

The UI owns connection and retry presentation, message validation, own/other
alignment, and draft retention. Takibi owns persistence, HTTP result envelopes,
snapshots, and WebSocket reconnection.
