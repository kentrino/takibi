---
title: Preserve string-query matches through SQLite candidate filtering
author: OpenAI Codex
cost: 3
priority: P1
priority_reason: "Negated string ranges and indexed string bounds can discard valid documents before the final JavaScript predicate runs."
category: correctness
status: closed
closed_reason: implemented
---

# Preserve string-query matches through SQLite candidate filtering

String predicates use JavaScript UTF-16 comparison while SQLite indexes use BINARY ordering. Negating an approximate SQL predicate or using an incompatible index range can exclude documents that satisfy the query. Make candidate filtering a safe superset of matches through boolean composition and indexed scans; preserve existing query membership and index/cursor ordering. Verify Unicode boundary cases, metadata fields, both directions, and pagination without weakening numeric ranges or equality prefixes.

[Accepted RFC](../../../rfcs/0002-string-query-candidate-safety.md)

## Related Files

- `packages/query/src/query.ts`
- `packages/storage/src/sql-query.ts`
- `packages/storage/src/index-sql.ts`
- `packages/storage/src/indexes.ts`
- `packages/storage/tests/storage.workers.ts`
- `packages/storage/tests/indexes.test.ts`
- `packages/takibi/README.md`
- `docs/rfcs/0012-typed-index-ordering.md`

## Resolution

Candidate SQL is a superset of JavaScript string membership. Each compiled
predicate records whether it is exact. AND and OR preserve that superset; NOT
negates only an exact predicate, and an inexact negated subtree becomes an
unrestricted candidate so the final JavaScript check decides membership. The
same rule applies to `id`, `createdAt`, and `updatedAt`.

Indexed scans still use equality prefixes, numeric ranges, SQLite BINARY order,
and keyset cursors. A string range bound is pushed only when every code unit is
below U+D800, where JavaScript UTF-16 order and SQLite BINARY order agree.
Combined bounds are simplified with JavaScript comparison. Scans omit
non-indexable index values so pagination can continue across rejected candidates
until the page is full or the scan ends. Numeric ranges and equality prefixes
still narrow in SQL. There is no public list API, stored-document, wire, or
migration change.

README and RFC 0012 distinguish JavaScript `where` membership from SQLite index
and cursor order. RFC 0002 was accepted on 2026-10-08, with implementation
complete.

Verification compares indexed and unindexed results with the JavaScript
predicate for range operators, nested NOT/AND/OR, supplementary and high-BMP
values, ASCII, missing and non-string values, metadata, both directions, limits,
and cursor walks that pass a chunk of rejected rows. SQL shape tests keep
numeric bounds, low-character string bounds, and equality prefixes. Validation:
`pnpm run ready` (format, lint, types, Node/Workers tests, package builds).
