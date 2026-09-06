# `@takibi/takibi-api`

Collection and action definition language for Takibi.

The package owns collection/action builders, immutable runtime definitions,
definition inference, public collection/action API types, and semantic error
classes. It consumes `@takibi/takibi-query`, `@takibi/takibi-policy`, and
`@takibi/takibi-shared-types`. It does not own HTTP routing, Hono handler
assembly, Durable Object execution, physical storage, or client transport.
