# Match the tracing adapter contract to core emissions

## Decision and evidence

Keep 0009 open at P3. Prefer narrowing the contract (A) if the release can accept the public type change; [B preserves the public union](./design-b.md) if compatibility is required. Core's output is smaller than the exported contract, but this alone does not prove that removing values is compatible.

`packages/worker-runtime/src/tracing.ts:14,33` defines five kinds and three statuses; `recordSpanException` only sends `error`. A repository-wide literal search for producer/consumer and status calls found no core producer/consumer emissions or unset/ok emissions. `packages/opentelemetry/src/index.ts` maps every current union value. `packages/cloudflare-tracing/src/index.ts:applyStatusAttributes` also consumes the public status, so the affected adapter surface is not limited to OpenTelemetry.

`e441a07` explicitly made core own span kinds and error policy while adapters translate; `59c5178` preserves that direction while centralizing call instrumentation. Neither history establishes that the full enum surface is required by external users. Conversely, `createOtelTakibiTracer()` publicly returns `TakibiTracer`, and `packages/opentelemetry/tests/index.test.ts` directly invokes its `startSpan`/`setStatus`. Thus the original claim that applications cannot use it for arbitrary spans is too strong. External use remains unconfirmed.

## Candidate A: narrow the existing types

The ideal core-to-adapter contract names only core behavior. Keep `SpanKind = "internal" | "client" | "server"`, set `SpanStatus.code` to `"error"`, and describe `setStatus` as failure notification. Remove unused OpenTelemetry branches; preserve exception recording, optional status message, and omission of a success status. Keep `takibi/instrumentation` and `@takibi/opentelemetry` entry points and registration/lifecycle unchanged. Check the Cloudflare adapter and recording tracer compile against the same contract.

No new package or provider dependency belongs in core. Future queue instrumentation must add a kind, an emission site, both adapter behavior and tests together. Span names, attributes, propagation, logging, and provider lifecycle are outside scope.

## Example

```ts
// Before: these compile against the exported Takibi tracer contract.
const span = tracer.startSpan({ name: "application.job", kind: "producer" });
span.setStatus({ code: "ok" });

// After: a custom queue span belongs to the application's provider API.
const span = otelTracer.startSpan("application.job", { kind: OtelSpanKind.PRODUCER });
span.setStatus({ code: SpanStatusCode.OK });
span.end();
```

Here `otelTracer`, `OtelSpanKind`, and `SpanStatusCode` come from the application's existing OpenTelemetry integration, not Takibi. This is a migration example for a caller affected by narrowing, not a recommendation to relabel a producer as internal. Custom adapters can remove unused kind/status branches. Core-generated failures still call `recordException` then `setStatus({ code: "error", message })`; successful spans end without status updates.

## Comparison, compatibility, and verification

A reduces adapter obligations and aligns types with behavior, but breaks applications constructing removed values or exhaustive tables keyed by those values. B preserves compatibility at the cost of continuing broader adapter obligations. Doing nothing without documenting actual emissions retains ambiguity. Introducing parallel public core-only and general-purpose span interfaces would add concepts and conversion burden unsupported by present needs.

Before choosing a release, check consumer/release compatibility requirements and compile available external adapter fixtures. If consumers require the broader contract, choose B rather than silently claiming a compatible cleanup. Lack of downstream visibility is not evidence of non-use. No storage, HTTP wire, or persisted-data migration is involved.

Verified here: public exports, both adapters, direct caller in OpenTelemetry tests, history rationale, and all repository literal status/removed-kind occurrences were inspected. No tests were executed. For A, type tests must reject removed values and accept retained ones; all three kinds must map correctly; failures must record exceptions plus error status and successes omit status. For B, retain broad type acceptance and test actual core emissions. Both candidates must retain published entry points and pass type checks, worker-runtime/OpenTelemetry/Cloudflare tests and the repository gate.

## Original Scope

In scope:

- the span kind/status contract between Takibi core and tracing adapters;
- corresponding OpenTelemetry mappings and type tests;
- public types exposed through `takibi/instrumentation`.

Out of scope:

- span names, attributes, exceptions, or context propagation;
- queue producer/consumer instrumentation;
- explicit OpenTelemetry `OK` status on success;
- tracer registration, provider lifecycle, logging, or trace-log correlation.

## Original Acceptance criteria

- `SpanKind` accepts only `internal`, `client`, and `server`.
- `SpanStatus.code` accepts only `error`.
- Type tests reject producer/consumer kinds and unset/ok statuses.
- All core-generated span kinds map to the corresponding OpenTelemetry kind.
- Failures still record the exception and OpenTelemetry error status; successful spans still omit an
  explicit status.
- The published `takibi/instrumentation` and `@takibi/opentelemetry` entry points do not change.
- `vp check`, worker-runtime tests, OpenTelemetry tests, and the repository-wide test gate pass.
