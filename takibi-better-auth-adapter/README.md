# @takibi/takibi-better-auth-adapter

Better Auth database adapter for trusted Takibi collections inside one
SQLite-backed Durable Object.

## Setup

Define the storage schemas in the application. They must include every field
added through Better Auth plugins and `additionalFields`, but must not declare
Takibi's server-managed `id`, `createdAt`, `updatedAt`, `rev`, or
`$schemaVersion`.

```ts
import { betterAuth } from "better-auth";
import { z } from "zod";
import { defineBetterAuthCollections, takibiAdapter } from "@takibi/takibi-better-auth-adapter";

const authCollections = defineBetterAuthCollections({
  user: z.object({
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable().optional(),
  }),
  session: z.object({
    expiresAt: z.iso.datetime(),
    token: z.string(),
    ipAddress: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
    userId: z.string(),
  }),
  account: z.object({
    accountId: z.string(),
    providerId: z.string(),
    userId: z.string(),
    accessToken: z.string().nullable().optional(),
    refreshToken: z.string().nullable().optional(),
    idToken: z.string().nullable().optional(),
    accessTokenExpiresAt: z.iso.datetime().nullable().optional(),
    refreshTokenExpiresAt: z.iso.datetime().nullable().optional(),
    scope: z.string().nullable().optional(),
    password: z.string().nullable().optional(),
  }),
  verification: z.object({
    identifier: z.string(),
    value: z.string(),
    expiresAt: z.iso.datetime(),
  }),
});

const app = takibi.defineCollections({
  ...authCollections,
  staffMembers,
});
const handler = app.actions({});

const models = {
  user: {
    collection: "authUsers",
    schema: authCollections.authUsers.schema,
    indexes: authCollections.authUsers.indexes,
  },
  session: {
    collection: "authSessions",
    schema: authCollections.authSessions.schema,
    indexes: authCollections.authSessions.indexes,
  },
  account: {
    collection: "authAccounts",
    schema: authCollections.authAccounts.schema,
    indexes: authCollections.authAccounts.indexes,
  },
  verification: {
    collection: "authVerifications",
    schema: authCollections.authVerifications.schema,
    indexes: authCollections.authVerifications.indexes,
  },
} as const;

export class TenantStore extends handler.DurableObject {
  readonly auth = betterAuth({
    database: takibiAdapter({
      collections: this.$collections,
      transaction: (run) => this.$collections.$transaction(run),
      models,
    }),
  });
}
```

`defineBetterAuthCollections` sets every public `accessPolicy` to `none`.
Authentication documents are credentials and must only be accessed through
the adapter's trusted in-object facade. Do not pass a public Takibi client or
expose the trusted facade over RPC.

## Schema compatibility

Better Auth builds its database schema from the enabled plugins and
`additionalFields`. Before the first operation, the adapter checks each mapped
Takibi schema against that runtime contract. It rejects missing mappings,
dropped fields, incompatible storage types, and unsupported `fieldName`
renames.

Compatibility checks use representative storage-form values. If a schema has
a semantic refinement such as UUID, add a non-secret `schemaSamples` value to
that model binding:

```ts
user: {
  collection: "authUsers",
  schema: authCollections.authUsers.schema,
  indexes: authCollections.authUsers.indexes,
  schemaSamples: { organizationId: "0196e2e2-f03d-7a54-b99c-8f01d4dbf9ba" },
}
```

The admin plugin adds `role`, `banned`, `banReason`, and `banExpires` to `user`,
and `impersonatedBy` to `session`; applications enabling it must add those
fields to their schemas. A plugin that adds a model must provide both a Takibi
collection and a `models` entry with its collection name and schema.

## Indexes and fallback scans

The helper declares unique constraints for email, session token,
provider/account identity, and verification identifier/value. It also declares
the indexes needed by common lookup and revoke paths. Takibi unique constraints
are the source of truth; the adapter does not perform a race-prone uniqueness
precheck.

The adapter pushes sensitive `eq` / `ne` / `in` / `not_in`, ranges,
`contains` / `starts_with` / `ends_with`, AND, and OR into Takibi. Dates are
converted to ISO 8601 strings, Better Auth's missing-or-null equality is
preserved, `findOne` uses `list({ limit: 1 })`, counts use Takibi `count`, and
conditional writes use the trusted atomic mutation methods.

Case-insensitive matching, arbitrary sort fields, offset, unbounded joins, and
filters that exceed Takibi's query bounds still use a bounded server-side
fallback scan. Bounded joins use a limited Takibi query instead. The default
scan limit is 10,000 documents and can be lowered with `maxScanItems`.

Use `onFallbackScan` for metadata-only observability:

```ts
takibiAdapter({
  // ...
  onFallbackScan: (event) => logger.debug("auth adapter fallback", event),
});
```

Events contain only model, operation, operator names, and the number of
candidate documents inspected by the adapter. They never include documents,
field values, tokens, or credentials.

## Migration

The adapter does not migrate an existing Better Auth backend. Export the four
models while writes are stopped, transform dates to ISO 8601 strings, import
them through a trusted one-off process, verify counts and unique constraints,
then switch the application to this adapter. Do not dual-write to the old and
new backends; it creates two competing sources of truth.

Removing the previous Durable Object binding, migration history, or database
is an application deployment concern and should happen only after rollback is
no longer required.

## Contract tests

The package runs Better Auth 1.6.26's official normal, joins,
case-insensitive, and auth-flow suites. The three tests that require
`fieldName` renames are skipped because that feature is rejected explicitly.
Transaction rollback and concurrent single-use operations run against an
actual Workers SQLite Durable Object in addition to the local contract tests.
