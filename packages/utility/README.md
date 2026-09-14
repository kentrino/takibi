# `@takibi/utility`

Shared utilities for Takibi packages.

The package is dependency-light and does not import the Takibi runtime, HTTP
framework, storage, or Cloudflare APIs.

JSON value and object assertions live here so storage, migrations, and
action output can share one nesting cap and one prototype check.
