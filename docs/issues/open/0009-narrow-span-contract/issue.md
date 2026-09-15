---
title: Narrow the Takibi span contract to kinds and statuses emitted by the core
author: OpenAI Codex
cost: 2
priority: P3
priority_reason: "The current union overstates adapter obligations but does not cause incorrect runtime behavior."
category: observability
source_issue: 0045-narrow-takibi-span-contract
---

# Problem

The public `takibi/instrumentation` contract defines `SpanKind` as `internal`, `client`, `server`,
`producer`, or `consumer`, and `SpanStatus.code` as `unset`, `ok`, or `error`.

Takibi core currently emits only:

- `internal` for internal work;
- `client` for Worker-to-Durable-Object calls;
- `server` for execution inside the Durable Object;
- `error` when an operation fails.

Successful spans leave provider status unchanged. No core path emits producer/consumer kinds or
explicit unset/ok statuses. This is a core-to-adapter output contract, not an API for applications to
start arbitrary spans, so listing values the core never produces forces adapters to implement
unreachable branches and makes the actual input range unclear.

# Proposal

Narrow `SpanKind` in `packages/worker-runtime/src/tracing.ts` to
`"internal" | "client" | "server"`. Narrow `SpanStatus.code` to `"error"` and document
`setStatus` as the failure-notification surface. Preserve the current behavior of not setting an
explicit status on successful spans.

Remove unreachable mappings from `packages/opentelemetry/src/index.ts`. Takibi does not promise to
mirror every OpenTelemetry enum member. If the core later instruments queue production or
consumption, add the union member, emission site, adapter mapping, and tests together.

# Scope

In scope:

- the span kind/status contract between Takibi core and tracing adapters;
- corresponding OpenTelemetry mappings and type tests;
- public types exposed through `takibi/instrumentation`.

Out of scope:

- span names, attributes, exceptions, or context propagation;
- queue producer/consumer instrumentation;
- explicit OpenTelemetry `OK` status on success;
- tracer registration, provider lifecycle, logging, or trace-log correlation.

# Acceptance criteria

- `SpanKind` accepts only `internal`, `client`, and `server`.
- `SpanStatus.code` accepts only `error`.
- Type tests reject producer/consumer kinds and unset/ok statuses.
- All core-generated span kinds map to the corresponding OpenTelemetry kind.
- Failures still record the exception and OpenTelemetry error status; successful spans still omit an
  explicit status.
- The published `takibi/instrumentation` and `@takibi/opentelemetry` entry points do not change.
- `vp check`, worker-runtime tests, OpenTelemetry tests, and the repository-wide test gate pass.
