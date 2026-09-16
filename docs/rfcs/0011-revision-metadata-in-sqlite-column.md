---
id: "0011"
title: Store document revisions as reserved SQLite column metadata
status: accepted
implementation: complete
created: 2026-09-16
---

# Store document revisions as reserved SQLite column metadata

Layout version 2 stores server-managed revisions in `revision REAL NOT NULL`, constrained to positive integral values, rather than domain JSON; reads reconstruct public `rev`. JavaScript revisions remain finite positive integers and advance to a greater representable IEEE-754 number beyond `Number.MAX_SAFE_INTEGER`, which SQLite signed 64-bit integers cannot represent.

Version 1 migrates by transactional table rebuild: preserve valid `data.rev`, normalize missing/invalid legacy values to `1`, remove top-level `rev`, and advance the layout version only after validated copying. The public contract remains optional `set`/`update` revision preconditions, `STALE_WRITE` on mismatch, last-write-wins when omitted, and monotonic advancement, using existing transactional read-check-write rather than SQL compare-and-swap. Application schemas and `list.where` do not expose the internal column. Migration incurs one synchronous rebuild.
