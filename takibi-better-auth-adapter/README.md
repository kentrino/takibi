# @takibi/takibi-better-auth-adapter

Better Auth database adapter for trusted Takibi collections inside one
SQLite-backed Durable Object.

## Setup

Create the Better Auth core storage schemas from the application's Zod module,
then extend them with fields added by plugins, `additionalFields`, and the
application domain. The factory uses dependency injection and does not load
Zod at runtime by itself. Schemas must not declare Takibi's server-managed
`id`, `createdAt`, `updatedAt`, `rev`, or `$schemaVersion`.

```ts
import { betterAuth } from "better-auth";
import { z } from "zod";
import {
  createZodBetterAuthBaseSchemas,
  defineBetterAuthCollections,
  takibiAdapter,
} from "@takibi/takibi-better-auth-adapter";

const base = createZodBetterAuthBaseSchemas(z);

const userSchema = base.user
  .extend({
    role: z.enum(["member", "admin"]),
    banned: z.boolean().nullable().optional(),
    banReason: z.string().nullable().optional(),
    banExpires: z.iso.datetime().nullable().optional(),
    organizationId: z.string(),
  })
  .superRefine(validateOrganizationRole);

const sessionSchema = base.session.extend({
  impersonatedBy: z.string().nullable().optional(),
});

const authCollections = defineBetterAuthCollections({
  user: {
    extends: {
      schema: userSchema,
      indexes: { byOrganization: ["organizationId", "createdAt"] },
      seed: seedUsers,
    },
  },
  session: { extends: { schema: sessionSchema } },
  account: base.account,
  verification: base.verification,
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
      models,
    }),
  });
}
```

`defineBetterAuthCollections` sets every public `accessPolicy` to `none`.
Authentication documents are credentials and must only be accessed through
the adapter's trusted in-object facade. Do not pass a public Takibi client or
expose the trusted facade over RPC.

The bare schema form is shorthand for `{ extends: { schema } }`. `extends`
only adds `indexes`, `unique`, `seed`, and `migrations`; schema composition
happens beforehand with Zod's `.extend()`, `.superRefine()`, or `.transform()`.
These options cannot replace the helper-owned policy or constraints. Reserved
names (`byEmail`, `byToken`, `byProviderAccount`, `byIdentifierValue`,
`byUser`, and `byExpiry`) are rejected by the type and with a synchronous
`TypeError`.

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
matching covering indexes for those tuples, plus user/time indexes for sessions
and accounts and an expiry/time index for verifications. Application indexes
and unique constraints supplied through `extends` are additive. Takibi unique
constraints are the source of truth; the adapter does not perform a race-prone
uniqueness precheck.

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
