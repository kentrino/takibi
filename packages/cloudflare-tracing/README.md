# @takibi/cloudflare-tracing

Adapts Cloudflare Workers native tracing to Takibi's tracer contract so
Takibi spans nest in the Workers dashboard next to platform operations.

This package does not use the OpenTelemetry API. For OTLP export, use
`@takibi/opentelemetry` instead. Do not enable both adapters in the same
isolate; they share Takibi's process-local tracer registry.

```sh
pnpm add takibi @takibi/cloudflare-tracing
```

Enable Workers tracing. `enterSpan` needs a current `compatibility_date`.
This adapter does not import Node.js APIs and does not need `nodejs_compat`
or `nodejs_als`. Parentage uses Workers native async context.

```jsonc
{
  "compatibility_date": "2026-08-18",
  "observability": {
    "traces": {
      "enabled": true,
    },
  },
}
```

Call `enable()` once per isolate with the runtime `tracing` object. Flush
stays with Cloudflare; there is no provider to `waitUntil`.

```ts
import { tracing } from "cloudflare:workers";
import { createTakibi, fullAccess } from "takibi";
import { CloudflareTakibiInstrumentation } from "@takibi/cloudflare-tracing";
import { z } from "zod";

new CloudflareTakibiInstrumentation().enable(tracing);

declare const tenantStore: DurableObjectNamespace;

const app = createTakibi()({
  resolve: () => ({ tenantId: "demo" }),
  stub: ({ resolved }) => tenantStore.getByName(resolved.tenantId),
})
  .defineCollections({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy: fullAccess,
    },
  })
  .actions({});

export default {
  fetch(request: Request): Promise<Response> {
    return app.fetch(request);
  },
};
```

Call `enable(tracing)` in every isolate that should emit Takibi spans,
including Durable Object classes. `import { tracing } from "cloudflare:workers"`
works outside the handler.

## Mapping

Span names, kinds, and `takibi.*` attributes are selected by Takibi core.
This package maps them onto `tracing.enterSpan()`:

- Each Takibi `withSpan` becomes one `enterSpan`. The native span stays
  active until the callback's returned promise settles, so nested Takibi
  spans and platform `fetch` / KV work nest correctly.
- `span.kind` is recorded as the `span.kind` attribute. Workers has no
  separate span-kind field.
- Exceptions become `error.type`, `error.message`, and `error.stack`.
  Status becomes `otel.status_code` and `otel.status_description`. Workers
  does not yet expose `setOutcome`.
- `inject` / `extract` are no-ops. Workers already propagates native
  context across Durable Object fetches. Cloudflare does not yet expose
  `spanContext()` for W3C `traceparent`.
- Synthetic Takibi span IDs are local to each `startSpan` call. Cloudflare
  parentage is the `enterSpan` async context, not those IDs.

Use the typed `TAKIBI_SPAN` and `TAKIBI_ATTR` constants from
`takibi/instrumentation` when dashboards need these stable names.
`createCloudflareTakibiTracer(tracing)` is the same adapter without
registering the process-local backend; tests and custom context wiring
can call it directly.

Do not wrap Takibi in `registerInstrumentations()`. Use
`CloudflareTakibiInstrumentation` directly.
