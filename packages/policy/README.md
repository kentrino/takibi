# `@takibi/policy`

Access-policy kernel for Takibi.

The package owns opaque `AccessGrant` values, WeakMap-backed capability
identity, AND/OR composition, schema/context policy helpers, and
denial-reason attribution. Policy-owned list ranges use `@takibi/query` for
validated query composition and scope-token provenance. Dependencies point from
policy to query to protocol/shared-types. It does not import the Takibi runtime,
HTTP framework, storage, or Cloudflare APIs.
