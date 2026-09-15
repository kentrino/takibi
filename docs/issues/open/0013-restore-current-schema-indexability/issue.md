---
title: Make restored snapshots immediately queryable at the current schema
author: OpenAI Codex
cost: 3
priority: P1
priority_reason: "Restore can report success while indexed queries silently omit valid documents, making the recovery point unreliable."
category: recovery
source_issue: 0057-restore-current-schema-indexability
---

# Problem

Restore validates migrated documents but stores the original old-schema rows. An indexed query can
then silently omit documents until a `get` lazily migrates them. Restore correctness must not depend
on which read happens first.

Successful restore must make all restored documents immediately queryable under current collection
definitions, preserve IDs, timestamps, and revisions, and leave live data unchanged on failure.

# Related Files

- [Design A](./design-a.md)
- [Restore lifecycle adapter](../../../../packages/worker-runtime/src/snapshot.ts)
- [Document migration](../../../../packages/worker-runtime/src/migrations.ts)
- [Lifecycle types](../../../../packages/snapshot/src/types.ts)
- [Restore pipeline](../../../../packages/snapshot/src/snapshot.ts)
- [Atomic cutover](../../../../packages/snapshot/src/maintenance.ts)
- [Indexed SQL queries](../../../../packages/storage/src/index-sql.ts)
- [Restore integration tests](../../../../packages/takibi/tests/snapshot.test.ts)
- [Snapshot specification](../../../../packages/snapshot/docs/spec/logical-snapshots.md)
