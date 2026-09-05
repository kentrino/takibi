# `@takibi/takibi-protocol`

Dependency-light codecs for Takibi transport contracts.

The package parses JSON strings into normalized query/order ASTs, validates
already-decoded AST values, and encodes or decodes the internal wire envelope.
It depends only on `@takibi/takibi-shared-types` and does not import the
Takibi runtime, HTTP framework, storage, or Cloudflare APIs.
