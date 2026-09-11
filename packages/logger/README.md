# `@takibi/logger`

Shared logger and log-event contracts for Takibi packages.

The package owns `LogEvent`, `LogLevel`, the internal `emit` logger, and the
public `Logger` sink interface. Filtering, console adapters, span-timed emit,
and tracing stay in `@takibi/worker-runtime`. It depends only on
`@takibi/shared-types` and does not import the runtime, contract,
HTTP framework, storage, or Cloudflare APIs.
