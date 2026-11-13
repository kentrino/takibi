# `@takibi/testing`

Node-only SQLite test handler adapter for Takibi.

The package owns `withSqliteTestBackend` and the Node `node:sqlite`
Durable Object storage emulation used by tests. It consumes runtime
assembly only through `@takibi/worker-runtime/testing-bridge`
and depends on `@takibi/api`, `@takibi/node-sqlite`, `@takibi/storage`, and
`@takibi/worker-runtime`. Its in-memory test databases open through the
production `node:sqlite` connection of `@takibi/node-sqlite`.

It does not own `createTakibi`, browser `createClient`, production
Durable Object execution, or unsupported memory executors and storage
factories. `takibi/testing` remains a thin compatibility
re-export of this package's public root.

This package imports `node:sqlite` and is for Node integration tests
only. Do not import it from Worker or browser production entries.

Handlers returned by `withSqliteTestBackend` implement `Symbol.asyncDispose`
and `Symbol.dispose`. Both close the in-memory database after startup and
in-flight work settled. A startup failure that no request reported is
reported exactly once, by whichever disposal is called first:
`Symbol.asyncDispose` rejects with it; `Symbol.dispose` cannot return it, so
it emits a `takibi.error` event to the configured logger, or calls
`console.error` when no logger is configured, and never leaves an unhandled
rejection. The disposal called second does not report it again.
