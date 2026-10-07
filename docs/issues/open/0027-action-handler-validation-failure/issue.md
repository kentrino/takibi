---
title: Return structured validation failures from action handlers
author: Cursor Agent
cost: 2
priority: P2
priority_reason: "Validation that depends on stored data can only run in the handler, and today it reaches the client as one operation message, so forms lose per-field errors and applications invent their own message encodings."
category: devex
---

# Return structured validation failures from action handlers

Action input is checked by `.input(schema)` before the handler runs, and a
failure reaches the client as `{ kind: "validation", code: "VALIDATION",
issues }`. The input schema cannot read `collections`, so validation that
depends on stored data has to run inside the handler. The handler has no public
way to raise a `validation` failure:

- `toTakibiFailure` maps only `SchemaValidationError` to `kind: "validation"`.
  Every other `TakibiError` becomes `kind: "operation"` regardless of `code`, so
  `new TakibiError("VALIDATION", messages.join("\n"), 400)` reaches the client
  as an operation failure without `issues`.
- `SchemaValidationError` is internal to `@takibi/worker-runtime`; the `takibi`
  entry does not export it.

An integrating application runs `validateDraft(input, collections)` in a
handler and throws the result as `TakibiError("VALIDATION", …)`, which loses
the form field each message belongs to.

Completion means a handler can throw a public error that reaches the client
as a `kind: "validation"` failure with application-supplied `issues`, which
the client handles in the same branch as input-schema failures.

## Rules

- The wire envelope stays as it is. `isWireResponse` accepts a `validation`
  failure only with `code: "VALIDATION"`, `status: 400`, and an `issues` array.
  The watch decoder allows `issues` only on `validation` failures.
- Server code throws and the client boundary returns `TakibiResult`
  ([RFC 0008](../../../rfcs/0008-server-throws-client-results.md)).
- `issues` are serialized to the client verbatim, the same way
  `TakibiError.message` is.

## Open Decisions

- Class name, and whether `ValidationIssue` is exported by name from `takibi`
  and `takibi/client` or only appears inline in the constructor signature.
- What `path` is relative to for handler-raised issues, and how the README
  states it. Paths for schema failures from writes inside a handler are
  tracked in [issue 0028](../0028-handler-write-schema-failure-surface/issue.md).

[Design](./design-a.md)

## Related Files

- `packages/worker-runtime/src/result.ts` — `toTakibiFailure` maps only `SchemaValidationError` to `validation`
- `packages/worker-runtime/src/context/runtime.ts` — `normalizeInvocationFailureForServer` and `statusOf`
- `packages/worker-runtime/src/schema.ts` — internal `SchemaValidationError`
- `packages/api/src/errors.ts` — public `TakibiError` subclasses
- `packages/takibi/src/index.ts` — public entry exporting the error classes
- `packages/shared-types/src/index.ts` — `ValidationIssue` and `TakibiValidationFailure`
- `packages/protocol/src/wire.ts` — `isWireResponse` validation checks
- `packages/protocol/src/watch.ts` — per-kind failure key check
- `packages/takibi/README.md` — Actions section splits failures into input validation and handler `TakibiError`
