# Owner-scoped collection policy

Document ownership is application domain data. Keep the owner field in the
collection schema and define its semantics in an application-local policy
instead of treating it as library-managed metadata.

The following policy lets an owner create, read, update, and delete notes while
preventing owner reassignment. Administrators bypass the restriction.

```ts
import { createTakibi, fullAccess, grant, none, queryImpliesEquality } from "@takibi/takibi";
import { z } from "zod";

type User = {
  id: string;
  role: "admin" | "member";
};

const noteSchema = z.object({
  ownerId: z.string().min(1),
  title: z.string(),
});

const createContext = createTakibi();
const context = createContext({
  resolve: (): { tenantId: string; user: User | null } => ({
    tenantId: "acme",
    user: null,
  }),
});

const ownerGrant = grant("create", "get", "update", "delete");
const noteOwnerPolicy = context.policy(
  noteSchema.pick({ ownerId: true }),
  ({ user, operation, doc, nextDoc, where }) => {
    if (user?.role === "admin") return fullAccess;
    if (!user?.id) return none;

    const ownsCurrent = doc?.ownerId === user.id;
    const ownsNext = nextDoc?.ownerId === user.id;

    switch (operation) {
      case "add":
        return ownsNext ? ownerGrant : none;
      case "get":
      case "delete":
        return ownsCurrent ? ownerGrant : none;
      case "update":
        return ownsCurrent && ownsNext ? ownerGrant : none;
      case "set":
        return doc === undefined
          ? ownsNext
            ? ownerGrant
            : none
          : ownsCurrent && ownsNext
            ? ownerGrant
            : none;
      case "list":
        return queryImpliesEquality(where, "ownerId", user.id) ? grant("list") : none;
    }
  },
);

const handler = context
  .defineCollections({
    notes: {
      schema: noteSchema,
      accessPolicy: noteOwnerPolicy,
      indexes: {
        byOwner: ["ownerId", "createdAt"],
      },
    },
  })
  .actions({});
```

Clients must send `ownerId`; fire does not insert it. Trusted Durable Object
`$collections` calls bypass `accessPolicy`, but schema validation still applies.

The member policy grants `list` only when the complete query implies
`ownerId.eq(user.id)`. This accepts `and(ownerId.eq(user.id), ...)` and rejects
an absent query, another owner value, `or(ownerId.eq(user.id), ...)`, and
`not(ownerId.eq(other))`. Filtering runs in trusted server storage before the
response is built, so unrelated documents are not returned to the client.

Pair that equality with the `byOwner` index so owner lists scan
`ownerId, createdAt, id` instead of the collection id order:

```ts
const page = await client.notes.list({
  index: "byOwner",
  where: (query) => query.ownerId.eq(user.id),
  orderBy: (query) => query.createdAt.desc(),
  limit: 20,
});
```

`orderBy` cannot stand alone, and `createdAt` is valid only because `ownerId`
is a single-value equality. Writes still update `takibi_documents` only;
SQLite maintains the expression index and pays write amplification on those
fields. Adding the index, or advancing the notes schema version, backfills
existing documents during activation and blocks that tenant until the index is
ready. Unindexed `list` remains available and stays id-ordered; there is no
automatic fallback from an invalid indexed request to that scan.

For a different owner field such as `authorId`, pick and compare that field
instead. If ownership transfer is valid in the domain, model it as a separate
privileged action rather than weakening the ordinary update rule.
