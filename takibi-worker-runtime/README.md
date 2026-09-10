# `@takibi/takibi-worker-runtime`

Cloudflare Worker and Durable Object execution for Takibi.

The package owns `createTakibi`, HTTP route decoding, wire-to-domain error
adaptation, CRUD/action dispatch, document lifecycle (schema validation,
prepareAdd/Set/Update, revision preconditions, unique enforcement, lazy
migrations, seeds), logging/tracing, and Durable Object composition. DO
`fetch` and in-process executors share `resolveLocalExecution`, which
resolves contract `RUNTIME_ADAPTER_GRAPH` plus Takibi construction slots:
instrumentation, `callToSingleResponse` / `callToBatchResponse`, and
`localExecution`. Policy, schema, and action-handler collaborators are
graph nodes; `inject(InvocationPrepareApply)` builds the shared none /
apply / full prepare-apply class. `TakibiInvocationRuntime` is the concrete collaborator bag on
`TakibiInvocationTypeMap.runtime`. Concrete invocation adapters, defaults, and
transaction wiring are registered once in
`createTakibiInvocationAdapterFactories` /
`TAKIBI_INVOCATION_REGISTRATION_GRAPH`. Production `invocationNotify` stays
unbound; an observer that needs services closes over them at construction. `createBoundInvocationAdapters` is the
async thin resolve of that same registration (tatenuki `resolve` is async).
`resolveLocalAdapterMap` adds `invocationRun` instrumentation and Call /
local-execution slots on top; it does not re-list those adapters. Direct
`executeAction` and top-level invocation call the same prepare-apply instance:
the public difference is throw versus settlement of the original adapter error.
Production and tests share this path and can override a collaborator. Policy /
schema / handler spans come from the registration factories; the executor span
is applied only to `invocationRun`. HTTP materialization uses the contract's
`jsonResponseFromStatus` with Fetch `Response` as the `JsonResponseLike`
factory. Worker HTTP uses the envelope Call runner; production dispatch
forwards one envelope through a stub hop. Invocation adapters settle mapped failures as `TakibiFailure`;
response adapters wrap those values as `{ ok: false; error }` for wire and
HTTP. `toWireFailure` remains the exception-to-envelope helper for existing
wire callers.
Worker public HTTP decodes and resolves application context once, then either
forwards one Call envelope through a stub hop or hands the decoded Call to the
in-process executor. Envelope progression is contract `Call`. Worker HTTP
resolves `ENVELOPE_ADAPTER_GRAPH` plus request-scoped construction slots
(`request`, `initial`, decoder, resolver, `execute`, logger, tracer, clock)
through tatenuki, `inject(Call)`s the class node, and wraps the
`callResolveContext` factory with `withTracing` so only that adapter owns the
resolve span. Production and testing share this path and swap `callDispatch`
or `execute`. It
depends on `@takibi/takibi-api`, `@takibi/takibi-policy`,
`@takibi/takibi-query`, `@takibi/takibi-protocol`,
`@takibi/takibi-storage`, `@takibi/takibi-snapshot`,
`@takibi/takibi-shared-types`, `@takibi/takibi-logger`,
`@takibi/takibi-utility`, `@takibi/takibi-worker-runtime-contract`,
`@standard-schema/spec`, `hono`, and `tatenuki`.

It does not own browser `createClient`, Node SQLite test adapters, query AST
construction, policy grant composition, collection/action builders, or the
SQLite engine. Node SQLite test adapters live in `@takibi/takibi-testing`.
Testing registers an in-process executor through
`@takibi/takibi-worker-runtime/testing-bridge`; that subpath is not
exported from this package's root or from `@takibi/takibi`.
