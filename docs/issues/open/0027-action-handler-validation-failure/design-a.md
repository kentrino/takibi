# Design A: a public `TakibiValidationError` in `@takibi/api`

## Example

Proposed API; not implemented.

```ts
import { TakibiValidationError } from "takibi";

const submit = app
  .defineAction()
  .input(DraftInput)
  .policy(staffPolicy)
  .handler(async ({ input, collections }) => {
    const issues = await validateDraft(input, collections); // { message, path? }[]
    if (issues.length > 0) throw new TakibiValidationError(issues);
    // ...
  });

// client: same branch as input-schema failures
if (!result.ok && result.error.kind === "validation") {
  for (const issue of result.error.issues) form.setError(issue.path?.join("."), issue.message);
}
```

## Behavior

- `TakibiValidationError extends TakibiError` with `code: "VALIDATION"` and
  `status: 400` fixed, and an `issues: readonly ValidationIssue[]` field. It
  follows the `ForbiddenError` pattern: a `TakibiError` subclass that carries
  extra public data.
- `toTakibiFailure` checks for it after `SchemaValidationError` and before the
  operation fallback, and emits `{ kind: "validation", code: "VALIDATION",
message, status: 400, issues }`. `statusOf` and `emitFailure` need no change
  because they read `TakibiError.status` and `code`.
- The constructor takes wire-shaped `ValidationIssue`s, so the issues are
  JSON-safe by type and need no `normalizeValidationIssues` pass. The default
  message joins the issue messages, matching `SchemaValidationError`.

## Rejected alternatives

- Exporting `SchemaValidationError`: its constructor takes Standard Schema
  `Issue`s, which would put `@standard-schema/spec` types on the public error
  surface. It is also the internal signal for storage, migration, and revision
  schema checks, which a handler-facing API would then be tied to.
- Optional `issues` on operation failures: this changes `TakibiOperationFailure`,
  `isWireResponse`, and the watch decoder, and clients would read field errors
  from two failure kinds.

## Trade-off

`code` stays `"VALIDATION"`, so an application cannot return its own
machine-readable code together with `issues`. If that becomes necessary, an
optional field on `TakibiValidationFailure` can be added later. HTTP clients
already accept it because `isWireResponse` ignores extra keys on validation
failures, but the watch decoder's exact key list would need updating.

## Compatibility and verification

- Additive to `@takibi/api` and the `takibi` entry. The wire, watch, and
  client types are unchanged.
- Runtime tests: a handler throwing `TakibiValidationError` produces HTTP 400
  with `kind: "validation"` and the given issues over HTTP actions and the
  typed client; an empty `path` is omitted.
- README: the Actions section states that handlers can raise validation
  failures, what `path` is relative to, and that issue messages are sent to
  the client verbatim.
