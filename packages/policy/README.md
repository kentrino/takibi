# `@takibi/policy`

Access-policy kernel for Takibi.

The package owns opaque `AccessGrant` values, WeakMap-backed capability
identity, AND/OR composition, schema/context policy helpers, and
denial-reason attribution. It depends only on `@standard-schema/spec` and
`@takibi/shared-types` and does not import the Takibi runtime,
HTTP framework, storage, or Cloudflare APIs.
