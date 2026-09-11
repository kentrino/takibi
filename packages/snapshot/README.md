# `@takibi/snapshot`

Maintenance coordination and logical snapshot streaming for Takibi.

The package owns lease TTL, drain/staging/reset coordination, abandoned
cleanup, NDJSON framing, UTF-8 boundaries, record caps, manifests, counts, and
SHA-256 integrity. It depends on `@takibi/api`,
`@takibi/storage`, `@takibi/shared-types`, and
`@noble/hashes`. It does not own HTTP routing, action/CRUD dispatch, client
transport, typed document lifecycle, or the Takibi compatibility package.

Typed document validation, seed preparation, and Durable Object construction
live in `@takibi/worker-runtime`. Those adapters implement the
snapshot lifecycle ports defined here. The Takibi compatibility package
re-exports the adapters.

See [`docs/spec/logical-snapshots.md`](./docs/spec/logical-snapshots.md) for
the format, lease, compatibility, and atomicity contract.
