# `@takibi/query`

Typed query construction, in-memory evaluation, and conservative implication
analysis for Takibi.

The package compiles query and order builder callbacks into AST values,
evaluates those ASTs against documents, and answers conservative
equality-implication questions. It depends only on
`@takibi/protocol` and `@takibi/shared-types` and does not
import the Takibi runtime, HTTP framework, storage, or Cloudflare APIs.
