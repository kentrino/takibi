---
id: "0012"
title: Typed collection indexes define list scan order
status: accepted
implementation: complete
created: 2026-09-16
---

# Typed collection indexes define list scan order

Collections declare named composite indexes, and `list({ index })` selects the scan and result order as a public contract; without an index, listing is id-ascending. `orderBy` is index-bound: fields before its chosen field require single-value equalities, and the remaining suffix plus `id` use the selected direction. Invalid requests fail `BAD_REQUEST` rather than silently choosing another scan or sorting in memory.

The shared `takibi_documents` table uses library-owned SQLite partial expression indexes over JSON paths and metadata. Activation reconciles the catalog and schema versions, backfills documents before making changed indexes available (blocking that tenant), and runs `PRAGMA optimize` when DDL occurs. Opaque keyset cursors are tied to query, index descriptor, and ordering; residual filtering precedes page limits. Production SQLite is used for semantic tests.

This enables declared ordering and pagination at the cost of write amplification and blocking activation. There is no automatic index selection, unindexed `orderBy`, mixed-direction sorting, or indexing optional, nested, or boolean domain fields. Online index builds remain outside this decision. Revisit those limits only with a new accepted decision.
