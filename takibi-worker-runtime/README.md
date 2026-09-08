# `@takibi/takibi-worker-runtime`

Cloudflare Worker and Durable Object execution for Takibi.

The package owns `createTakibi`, HTTP route decoding, wire-to-domain error
adaptation, CRUD/action dispatch, document lifecycle (schema validation,
prepareAdd/Set/Update, revision preconditions, unique enforcement, lazy
migrations, seeds), logging/tracing, and Durable Object composition. DO
`fetch` and in-process executors share `resolveLocalExecution`, which
resolves contract `RUNTIME_ADAPTER_GRAPH` plus Takibi construction slots:
instrumentation, `callToSingleResponse` / `callToBatchResponse`, and
`localExecution`. HTTP materialization uses the contract's
`jsonResponseFromStatus` with Fetch `Response` as the `JsonResponseLike`
factory. Invocation adapters settle mapped failures as `TakibiFailure`;
response adapters wrap those values as `{ ok: false; error }` for wire and
HTTP. `toWireFailure` remains the exception-to-envelope helper for existing
wire callers.
Worker public HTTP decodes and resolves application context once, then either
forwards one Call envelope through a stub hop or hands the decoded Call to the
in-process executor. It
depends on `@takibi/takibi-api`, `@takibi/takibi-policy`,
`@takibi/takibi-query`, `@takibi/takibi-protocol`,
`@takibi/takibi-storage`, `@takibi/takibi-snapshot`,
`@takibi/takibi-shared-types`, `@takibi/takibi-worker-runtime-contract`,
`@standard-schema/spec`, `hono`, and `tatenuki`.

It does not own browser `createClient`, Node SQLite test adapters, query AST
construction, policy grant composition, collection/action builders, or the
SQLite engine. Node SQLite test adapters live in `@takibi/takibi-testing`.
Testing registers an in-process executor through
`@takibi/takibi-worker-runtime/testing-bridge`; that subpath is not
exported from this package's root or from `@takibi/takibi`.
