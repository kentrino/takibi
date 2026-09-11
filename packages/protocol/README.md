# `@takibi/protocol`

Dependency-light codecs for Takibi transport contracts.

The package parses JSON strings into normalized query/order ASTs, validates
already-decoded AST values, and encodes or decodes the internal wire envelope.
Action and collection wire requests add a `context` envelope around the shared
single-invocation request data. Batch remains a call envelope whose items are
collection reads. Decoder acceptance is independent of those shared types:
`count` stays rejected on the wire, and batch items stay `get` / `list`.
It depends only on `@takibi/shared-types` and does not import the
Takibi runtime, HTTP framework, storage, or Cloudflare APIs.
