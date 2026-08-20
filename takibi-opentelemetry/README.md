# @takibi/takibi-opentelemetry

OpenTelemetry integration for `@takibi/takibi`. The core package has no
OpenTelemetry runtime or peer dependency; install this package with
`@opentelemetry/api` only in applications that enable tracing. Treat
`@takibi/takibi` as a peer of the same version the application imports.
A second copy of the core package isolates the tracer registry, so
`enable()` succeeds and spans stay silent.

Install the binding with its peers:

```bash
pnpm add @takibi/takibi @takibi/takibi-opentelemetry @opentelemetry/api
pnpm add -D @opentelemetry/sdk-trace-base
```

Register your tracer provider and an OpenTelemetry context manager before
`enable()` so instrumentation started inside Takibi spans inherits their active
context. Without a context manager, `enable()` still succeeds and emits no
spans. Call `enable()` once per isolate at module scope. Flush stays
application-owned.

`enable()` instruments `resolve`, Worker → Durable Object wire, executor,
policy, schema, storage, and actions. It does not change the public types of
collections, handlers, or clients.

Span kinds, attributes, exception recording, and status are selected by Takibi
core. This package maps them directly to the OpenTelemetry API:

- Worker → Durable Object `takibi.wire` spans use `CLIENT`; Durable Object
  `takibi.executor` spans use `SERVER`; local work uses `INTERNAL`.
- Collection, operation, action, action scope, storage operation, and available
  document IDs use `takibi.*` attributes.
- Document contents, resolved context, headers, and action input/output are
  never span attributes.
- Thrown values are normalized and assigned error status by core rather than by
  this adapter.

Use the typed `TAKIBI_SPAN` and `TAKIBI_ATTR` constants from
`@takibi/takibi/instrumentation` when dashboards or exporters need these
stable names.

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  ROOT_CONTEXT,
  trace,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  ParentBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { createTakibi, fullAccess } from "@takibi/takibi";
import { TakibiInstrumentation } from "@takibi/takibi-opentelemetry";
import { z } from "zod";

class AsyncLocalContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(activeContext, () => fn.call(thisArg, ...args));
  }

  bind<T>(_context: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#storage.disable();
    return this;
  }
}

const provider = new BasicTracerProvider({
  sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
});
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncLocalContextManager());
new TakibiInstrumentation().enable();

const app = createTakibi()({
  resolve: () => ({ tenantId: "demo" }),
}).collections(
  {
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy: fullAccess,
    },
  },
  { memory: true },
);

export default {
  async fetch(request: Request, _env: unknown, ctx: { waitUntil(task: Promise<unknown>): void }) {
    const response = await app.fetch(request);
    ctx.waitUntil(provider.forceFlush());
    return response;
  },
};
```

The application must retain the SDK provider it configured. The
`createOtelTakibiTracer()` adapter binds tracing APIs only; it does not discover
or flush a provider.

The core `@takibi/takibi` import does not require `nodejs_als`,
`nodejs_compat`, or a minimum compatibility date. This integration delegates
async context to the OpenTelemetry context manager you register; apply that
context manager's runtime compatibility requirements separately.

Calling `provider.forceFlush()` affects only the provider owned by the calling
Worker isolate. A Durable Object runs in a separate isolate with its own
provider, so this `waitUntil` does not flush spans buffered there. Configure,
retain, flush, and enable tracing independently in every isolate that emits
spans.

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
