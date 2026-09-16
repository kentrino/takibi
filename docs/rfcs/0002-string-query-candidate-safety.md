---
id: "0002"
title: Preserve JavaScript string-query membership through SQLite candidate selection
status: proposed
created: 2026-09-16
implementation_issues:
  - ../issues/open/0019-string-range-candidate-safety/issue.md
---

# Preserve JavaScript string-query membership through SQLite candidate selection

Takibi should preserve the existing split contract: `where` string membership follows
JavaScript UTF-16 relational comparison, while selected-index ordering and cursors follow
SQLite BINARY ordering. Candidate selection must never discard a document that the final
JavaScript predicate would match.

These orders differ for some Unicode values: JavaScript considers `"😀" < "\uE000"` true,
while SQLite BINARY does not. The ordinary unindexed compiler already widens a positive string
range whenever the bound contains a code unit at or above `0xD800`; this includes `\uE000`, not
only surrogate code units. That path is therefore not the defect.

Two unsafe paths remain. First, an approximate predicate cannot be blindly negated. The
2026-09-16 assessment reproduced `NOT(label < "\uE000")` against `{ label: "\uE000" }`: JavaScript matched
the document, but generated SQL selected zero rows because it negated the widened text-existence
candidate. Second, indexed scans emit string range bounds using SQLite order. SQLite rejects
`"😀" < "\uE000"`, although JavaScript accepts it, so residual evaluation never sees the row.
The first result used the repository compiler with an in-memory `node:sqlite` database; the
second combined SQLite bound-parameter reproduction with inspection of `index-sql.ts`. No fix
or full collection regression suite has yet been tested.

```ts
await posts.list({ where: (q) => q.not(q.label.lt("\uE000")) });
await posts.list({ index: "byLabel", where: (q) => q.label.lt("\uE000") });
```

The SQL compiler should track whether each candidate predicate is exact. AND and OR may compose
safe supersets, but NOT may negate only an exact predicate; an inexact negated subtree should
fall back to an unrestricted candidate predicate and final JavaScript evaluation. Apply the same
rule to metadata fields. Indexed scans must not use a physical string range unless equivalence or
a safe widening is proved. They may retain equality prefixes, numeric ranges, SQLite index order,
and keyset cursors. Pagination must continue across rejected candidates until the requested page
is full or the scan ends. Planner simplifications of combined string bounds must likewise use
JavaScript membership semantics, not assume that index collation supplies them. The README and
RFC 0012 should clarify the distinction between query membership and index result/cursor order.

Changing query membership to SQLite order would break existing JavaScript behavior. Persisting a
UTF-16-order projection would align membership and range scans, but adds storage, backfill, cursor,
and encoding complexity. Conservative candidates are the smallest compatible correction; later
narrowing requires an equivalence proof.

Verification should compare indexed and unindexed membership with JavaScript for all range
operators, nested NOT/AND/OR, supplementary and high-BMP values, ASCII, missing and non-string
values, metadata, both order directions, limits, and multi-chunk cursor traversal. Numeric range
and equality-prefix narrowing must remain covered. Native count must use an exact predicate or a
residual scan, not merely safe candidates; see [issue 0011](../issues/open/0011-storage-native-count/issue.md).
Any new physical layout from [issue 0014](../issues/open/0014-online-index-backfill/issue.md) must
preserve this contract. No public API, stored-document, wire, or migration change is proposed.
