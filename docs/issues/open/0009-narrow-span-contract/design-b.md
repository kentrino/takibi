# Candidate B: retain public unions and document core emissions

Keep all existing public kind/status values and adapter mappings. Document that core currently emits internal/client/server and error-only status, while callers of returned tracers may use the broader contract. Add emission regression tests instead of rejecting the currently accepted values.

## Example

```ts
// Before and after, this remains a valid public tracer call.
const span = tracer.startSpan({ name: "application.job", kind: "producer" });
span.setStatus({ code: "ok" });
span.end();
```

Core still never sets explicit success status. This requires no consumer migration and preserves direct use of both public adapter factories. It retains the extra branches and does not satisfy candidate A's proposed union-rejection tests; replace those with broad type-acceptance and core-emission tests if B is chosen. The shared required outcome is an unambiguous contract with unchanged runtime span behavior.

Choose B if existing public compatibility obligations prohibit A. It costs more adapter surface but avoids inventing parallel span types. See [evidence, comparison and verification](./design-a.md); external consumer requirements remain unconfirmed. No persisted-data or wire change is needed.
