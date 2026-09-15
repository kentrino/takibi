---
title: Define list/count consistency and evaluate transaction occupancy costs
author: OpenAI Codex
cost: 5
---

# Problem

Policy-bound `list/count` use `full`, placing policy, scanning, and lazy migration persistence
in one transaction. Takibi's storage queue makes subsequent root driver operations wait
until it finishes. `list` scans chunks and filters transformed documents; `count` reads
multiple pages to completion. Writes to other rows or collections in the same DO can also
be delayed.

This occupancy scope is established by the implementation; its practical latency has not
been measured. The current strong isolation is valid, so this is an investigation and
design task, not a presumed bug fix. See the
[isolation spec](../../../spec/collection-operation-isolation.md) for evidence.

# Design constraints

Distinguish per-row migration atomicity from consistency of a single page and of an entire
count. Splitting transactions by row does not guarantee a page represents one point in time.
Summing individually consistent pages also need not produce a count corresponding to one
point in time during concurrent updates. Distinguish the guarantees of `listAll` making
multiple public list calls from those of a single call.

Changing `full` to `apply` only moves policy outside the transaction; the entire list/count
in apply remains inside it. Reducing scan occupancy requires examining how reading,
transformation, and persistence are organized. The current `StorageDriver` has no
independent read-snapshot API.

Because `where` is evaluated after transformation, fetching only `limit` rows in SQL and
releasing the lock may not suffice. Index ordering, cursor continuation, lookahead, and
uniqueness checks must also be preserved. Operations inside an enclosing atomic action
or trusted `$transaction` must continue to participate in that boundary.

# Investigation

1. Measure list and count separately while varying the number of old-schema rows, filter
   selectivity, indexes, and uniqueness constraints. Record operation duration, SQL rows
   scanned, migrations performed, waiting time for a set on another row in the same DO,
   and memory usage.
2. Compare current public/policy-bound and trusted guarantees. Document the contracts for
   pages, counts, and calls spanning multiple pages.
3. Compare keeping `full`, separating response migration from per-row persistence, and
   omitting persistence on list in favor of persisting on get/write. Specify how each
   alternative obtains snapshots and at what cost. Do not assume materializing every
   candidate in memory is acceptable.
4. If persistence is separated, decide when uniqueness violations and migration failures
   are detected, which partial writes remain, and whether rechecked current rows can be
   mixed into the response. Explain differences from current operation-level rollback.
5. Select either the current approach or a change based on the evidence, and identify any
   implementation tasks needed.

# Acceptance criteria

- Record reproduction conditions and measurements; avoid unmeasured claims that the
  current boundary is excessive or an alternative is faster.
- Explain the consistency guaranteed for a single page, an entire count, and separate
  calls retrieving multiple pages.
- Migration racing with updates or deletion must not overwrite a newer row with an old
  transformed value.
- Any proposed change includes a verification plan covering filters, indexes, cursors,
  uniqueness, and partial-failure semantics.
- Any weakening of the README's operation-level isolation is explicitly identified as
  a contract change.
- Do not propose optimizations that release an enclosing atomic action or `$transaction`
  boundary partway through.
- Keeping the current implementation is a valid outcome if the rationale and conditions
  for reconsideration are recorded.

# Priority

This does not block the original PR's single-row isolation fix. Treat it as subsequent
performance and consistency design work. Opening this issue does not commit to changing
`list/count` to `apply` or to per-row persistence.
