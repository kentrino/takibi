---
id: "0010"
title: Preserve trace context across the Durable Object wire
status: accepted
implementation: complete
created: 2026-09-16
---

# Preserve trace context across the Durable Object wire

Propagation extraction returns both the optional parent span and a function that activates the complete extracted context:

```ts
type ExtractedTraceContext = {
  readonly span?: SpanContext;
  runWithActiveContext<T>(fn: () => T): T;
};
```

The OTel adapter sets the current Takibi span before injection. On receipt it extracts headers and activates that context around the server span and subsequent work. Core does not enumerate baggage or custom propagator values, preserving configured composite/custom propagation without an OTel dependency. Revisit if an interoperability requirement cannot be expressed by activation or a non-OTel adapter cannot implement the contract; consider an opaque adapter token then.
