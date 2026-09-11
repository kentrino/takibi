# `@takibi/takibi-storage`

Low-level Durable Object SQLite engine for Takibi.

The package owns document-table layout, operation serialization, cursors,
pagination, transactions, JSON1 query lowering, keyset scans, and index
planning, DDL, and catalog reconciliation. It depends on
`@takibi/takibi-api`, `@takibi/takibi-query`,
`@takibi/takibi-protocol`, and `@takibi/takibi-shared-types`. It does
not own schema validation, typed document transitions, revision advancement,
unique enforcement, lazy migrations, seeds, policy, snapshots, or
maintenance leases.
