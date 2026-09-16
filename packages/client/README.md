# `@takibi/client`

Typed HTTP client for Takibi collections and actions.

The package owns `createClient`, request construction, response-envelope
decoding, fixed-window collection-read batching, and client-side `listAll`
orchestration. It consumes `@takibi/api` for structural definitions
and errors, `@takibi/query` for list-option compilation,
`@takibi/protocol` for wire contracts, and
`@takibi/shared-types` for result envelopes. Action reason-code
inference reads `PolicyReasonCodeOf` from `@takibi/policy`.

It does not import Hono, Cloudflare Worker runtime, Durable Objects, Node APIs,
storage, or the Takibi compatibility package.

The separate `@takibi/client/watch` entry owns `createWatchClient`, native browser
WebSocket lifecycle, full-snapshot deduplication, and reconnect. The public SDK
exposes it as `takibi/watch`. The ordinary entry has no import of this lifecycle
module. Watch composition wraps an HTTP client without mutating it.
