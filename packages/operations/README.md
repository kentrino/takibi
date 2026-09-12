# @takibi/operations

Validate and authorize a decoded collection request, returning a prepared operation.

The only runtime export is `prepareCollection(context, adapters)`. Preparation resolves the collection, reads any required existing document, builds and validates candidate documents through `DocumentBuilder`, and evaluates policy. It does not persist changes or open transactions itself. A supplied storage driver may perform its own read-time migrations.

The returned value exposes `apply(storage)`. It captures the prepared state and selected implementation; the caller supplies the execution storage scope without inspecting or reconstructing that state. Write collisions and other persistence-time checks still run when applying the operation.

The worker runtime owns wire decoding, typed API construction, trusted maintenance operations, transaction selection, and lifecycle instrumentation. Individual operation classes are package implementation details.

Schema/document rules are supplied through the existing document builder adapter; this package owns their ordering with authorization and error concealment. Operations never import the worker runtime.

This is an internal workspace package. Applications should use `takibi`.
