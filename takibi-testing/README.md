# `@takibi/takibi-testing`

Node-only SQLite test handler adapter for Takibi.

The package owns `withSqliteTestBackend` and the Node `node:sqlite`
Durable Object storage emulation used by tests. It consumes runtime
assembly only through `@takibi/takibi-worker-runtime/testing-bridge`
and depends on `@takibi/takibi-api`, `@takibi/takibi-storage`, and
`@takibi/takibi-worker-runtime`.

It does not own `createTakibi`, browser `createClient`, production
Durable Object execution, or unsupported memory executors and storage
factories. `@takibi/takibi/testing` remains a thin compatibility
re-export of this package's public root.

This package imports `node:sqlite` and is for Node integration tests
only. Do not import it from Worker or browser production entries.
