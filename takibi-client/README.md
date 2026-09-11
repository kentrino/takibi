# `@takibi/takibi-client`

Typed HTTP client for Takibi collections and actions.

The package owns `createClient`, request construction, response-envelope
decoding, fixed-window collection-read batching, and client-side `listAll`
orchestration. It consumes `@takibi/takibi-api` for structural definitions
and errors, `@takibi/takibi-query` for list-option compilation,
`@takibi/takibi-protocol` for wire contracts, and
`@takibi/takibi-shared-types` for result envelopes. Action reason-code
inference reads `PolicyReasonCodeOf` from `@takibi/takibi-policy`.

It does not import Hono, Cloudflare Worker runtime, Durable Objects, Node APIs,
storage, or the Takibi compatibility package.
