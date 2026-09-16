---
title: Preserve string-query matches through SQLite candidate filtering
author: OpenAI Codex
cost: 3
priority: P1
priority_reason: "Negated string ranges and indexed string bounds can discard valid documents before the final JavaScript predicate runs."
category: correctness
---

# Preserve string-query matches through SQLite candidate filtering

String predicates use JavaScript UTF-16 comparison while SQLite indexes use BINARY ordering. Negating an approximate SQL predicate or using an incompatible index range can exclude documents that satisfy the query. Make candidate filtering a safe superset of matches through boolean composition and indexed scans; preserve existing query membership and index/cursor ordering. Verify Unicode boundary cases, metadata fields, both directions, and pagination without weakening numeric ranges or equality prefixes.

[RFC](../../../rfcs/0002-string-query-candidate-safety.md)

## Related Files

- `packages/query/src/query.ts`
- `packages/storage/src/sql-query.ts`
- `packages/storage/src/index-sql.ts`
- `packages/storage/src/indexes.ts`
- `packages/storage/tests/storage.workers.ts`
- `packages/storage/tests/indexes.test.ts`
- `packages/takibi/README.md`
- `docs/rfcs/0012-typed-index-ordering.md`
