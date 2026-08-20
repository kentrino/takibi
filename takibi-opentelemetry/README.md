# @takibi/takibi-opentelemetry

OpenTelemetry integration for `@takibi/takibi`. The core package has no
OpenTelemetry runtime or peer dependency; install this package with
`@opentelemetry/api` only in applications that enable tracing.

Register your tracer provider and an OpenTelemetry context manager before
`enable()` so instrumentation started inside Takibi spans inherits their active
context. Call `enable()` once per isolate at module scope. Flush stays
application-owned.

`enable()` instruments `resolve`, Worker → Durable Object wire, executor,
policy, schema, storage, and actions. It does not change the public types of
collections, handlers, or clients.

```ts
import { createOtelTakibiTracer, TakibiInstrumentation } from "@takibi/takibi-opentelemetry";

const instrumentation = new TakibiInstrumentation();
instrumentation.enable();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await app.fetch(request, env, ctx);
    ctx.waitUntil(createOtelTakibiTracer().forceFlush());
    return response;
  },
};
```

The core `@takibi/takibi` import does not require `nodejs_als`,
`nodejs_compat`, or a minimum compatibility date. This integration delegates
async context to the OpenTelemetry context manager you register; apply that
context manager's runtime compatibility requirements separately.

`forceFlush()` affects only the provider in the calling Worker isolate. A
Durable Object runs in a separate isolate with its own provider, so this
`waitUntil` does not flush spans buffered there. Configure and enable tracing in
every isolate that emits spans.

Takibi ends Durable Object spans when their work completes, then leaves export
to the registered processor and exporter. It does not guarantee export before a
Durable Object response completes. In particular, `BatchSpanProcessor` exports
on its configured schedule while the isolate remains alive; deployment,
runtime shutdown, or a crash can discard buffered spans. Takibi does not install
a Durable Object shutdown hook or offer request-scoped delivery. Choose
processor, exporter, and scheduling settings according to that best-effort
delivery semantic.

Use `enable()` / `disable()` directly. Do not wrap Takibi in
`registerInstrumentations()`.
