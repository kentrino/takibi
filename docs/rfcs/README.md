# RFCs

RFCs record a proposed or accepted design, its contract, and why it was chosen.
Keep each RFC focused and concise. Short contracts and examples belong in the
same document; a separate specification is not required. RFCs are the
repository's decision log. Accepted RFCs preserve adopted decisions and are
superseded by later RFCs when decisions change.

## Lifecycle

```yaml
---
id: "0001"
title: A concrete design choice
status: proposed
created: 2026-09-16
---
```

| Status       | Meaning                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `proposed`   | The design or choice among alternatives is still under discussion.     |
| `accepted`   | The stated decision has been adopted, independently of implementation. |
| `rejected`   | The proposed decision was considered and not adopted.                  |
| `withdrawn`  | The proposal was withdrawn without an adoption decision.               |
| `superseded` | A later RFC replaces this decision.                                    |

Use draft PRs for drafting; do not add a separate draft status. A problem without
design alternatives can remain an issue until there is a proposal to discuss.
An accepted decision to keep existing behavior is `accepted`, even if it rejects
a suggested refactor. Migration or an author's recommendation alone does not
establish acceptance.

For `accepted` RFCs, also record `implementation` as `pending`, `in-progress`,
`complete`, or `not-applicable`. Acceptance does not mean the design is implemented.
Use `not-applicable` when no implementation work is required by the decision;
use `complete` for an adopted design whose required work has been verified as done.
Omit this field for other statuses; implementation details remain in linked issues.

Optional metadata:

```yaml
status: accepted
implementation: pending
decided: 2026-09-16
implementation_issues:
  - ../issues/open/0020-transaction-callback-no-replay/issue.md
```

Include only fields that apply. `created` is the RFC's creation date; `decided`
is the known decision date. Issue paths are
relative to the RFC. IDs are unique, zero-padded strings and are never reused.
Use `NNNN-descriptive-name.md`; RFC and issue numbers are separate IDs.

Clarifications can update an existing RFC. A changed accepted decision needs a
new RFC: add `supersedes: ["0001"]` to the successor and
`superseded_by: ["0004"]` to the replaced RFC (using their actual IDs), then mark
the replaced RFC `superseded`. Keep rationale in the body,
not frontmatter. Keep current API reference documentation in sync with code;
an accepted RFC is not evidence that an API is already available.

## Proposals

- [Watch subscription lifecycle](./0001-watch-subscription-lifecycle.md)
- [String-query candidate safety](./0002-string-query-candidate-safety.md)
- [Transaction callback no-replay contract](./0003-transaction-callback-no-replay.md)
- [Partial updates revalidate the complete merged document](./0004-partial-update-full-revalidation.md)
- [Do not expose collection write lifecycle hooks](./0005-no-lifecycle-hooks.md)
- [Cloudflare Durable Objects only](./0006-cloudflare-durable-objects-only.md)
- [Separate action admission from document authorization](./0007-action-two-layer-authorization.md)
- [Throw inside the server and return results across the client boundary](./0008-server-throws-client-results.md)
- [Keep log events independent of OpenTelemetry](./0009-logging-sink-independent-from-opentelemetry.md)
- [Preserve trace context across the Durable Object wire](./0010-preserve-trace-context-across-durable-object-wire.md)
- [Store document revisions in a SQLite column](./0011-revision-metadata-in-sqlite-column.md)
- [Typed collection indexes define list scan order](./0012-typed-index-ordering.md)

These proposals are linked to their existing implementation issues, which
continue to track delivery. Resolved concerns and application-specific
requests are not copied merely to fill the RFC catalog.
