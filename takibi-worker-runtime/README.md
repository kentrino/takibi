# `@takibi/takibi-worker-runtime`

Cloudflare Worker and Durable Object execution for Takibi.

The package owns `createTakibi`, HTTP route decoding, wire-to-domain error
adaptation, CRUD/action dispatch, document lifecycle (schema validation,
prepareAdd/Set/Update, revision preconditions, unique enforcement, lazy
migrations, seeds), logging/tracing, and Durable Object composition. It
depends on `@takibi/takibi-api`, `@takibi/takibi-policy`,
`@takibi/takibi-query`, `@takibi/takibi-protocol`,
`@takibi/takibi-storage`, `@takibi/takibi-snapshot`,
`@takibi/takibi-shared-types`, `@standard-schema/spec`, and `hono`.

It does not own browser `createClient`, Node SQLite test adapters, query AST
construction, policy grant composition, collection/action builders, or the
SQLite engine. Testing registers an in-process executor through
`@takibi/takibi-worker-runtime/testing-bridge`; that subpath is not
exported from this package's root or from `@takibi/takibi`.
