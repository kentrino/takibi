# Design B: Observe responses in an application HTTP wrapper

Application middleware clones the matched response from handle, reads its JSON, and calls the notification service. Takibi ContextConfig and the lifecycle remain unchanged.

## Example

```ts
// Before
const result = await app.handle(request, options);
// After: Conceptual application wrapper
const result = await app.handle(request, options);
if (result.matched) {
  const body = await result.response.clone().json();
  await observeHttpSafely(body); // The application implements exception isolation and logging
}
return result;
```

The original response is preserved, but the application must distinguish decode/context failures from invocation failures at the HTTP layer, interpret batch arrays, and reconstruct invocation metadata and resolved ctx/services. This cannot unify the testing backend or entry points that bypass HTTP. Dependence on the existing wire format and duplication across applications remain.

Against the same single/batch/success/failure fixtures as A, this can observe HTTP transport, but meeting the all-paths requirement of one observation per settled public invocation requires internal knowledge. It adds no public API or migration cost, but is rejected because of the application burden. It becomes a candidate only if the requirement is narrowed to HTTP. Durable audit/outbox behavior requires a separate design and is not provided by this wrapper.
