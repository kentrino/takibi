# Owner-scoped collection policy

Document ownership is application domain data. Keep the owner field in the
collection schema and define its semantics in an application-local policy
instead of treating it as library-managed metadata.

The following policy lets an owner create, read, update, and delete notes while
preventing owner reassignment. Administrators bypass the restriction.

```ts
import { createTakibi, fullAccess, grant, none, listWhere } from "takibi";
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
  ({ user, operation, doc, nextDoc }) => {
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
      case "count":
        return grant(listWhere<z.infer<typeof noteSchema>>((q) => q.ownerId.eq(user.id)));
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

Clients supply `ownerId` when creating documents; Takibi does not insert it.
Trusted Durable Object `$collections` calls bypass `accessPolicy`, but schema
validation still applies.

The member policy supplies the owner range for both list and count. The server
ANDs that range with the client's view filter before index planning, pagination,
and count. An absent client filter lists the member's own notes; a conflicting
owner filter returns no rows. Administrators retain unrestricted access.
`queryImpliesEquality` remains available for optional application proofs; list
authorization does not require clients to repeat ownership predicates.

The policy equality supplies the `byOwner` index prefix, so clients can scan
`ownerId, createdAt, id` while specifying only their view filter:

```ts
const page = await client.notes.list({
  index: "byOwner",
  where: (query) => query.title.contains("TypeScript"),
  orderBy: (query) => query.createdAt.desc(),
  limit: 20,
});
```

`orderBy` cannot stand alone, and `createdAt` is valid only because `ownerId`
is a single-value equality in the effective query. Writes still update `takibi_documents` only;
SQLite maintains the expression index and pays write amplification on those
fields. Adding the index, or advancing the notes schema version, backfills
existing documents during activation and blocks that tenant until the index is
ready. Unindexed `list` remains available and stays id-ordered; there is no
automatic fallback from an invalid indexed request to that scan.

For a different owner field such as `authorId`, pick and compare that field
instead. If ownership transfer is valid in the domain, model it as a separate
privileged action rather than weakening the ordinary update rule.

List cursors use v4 and bind the requested filter and freshly authorized effective
query. Old v2/v3 tokens are rejected: restart the list after upgrading. The token
omits the server predicate AST; its SHA-256 binding is unkeyed and is neither a
secret nor authentication. Indexed tuples still expose fields from the last
returned row. Each continuation reauthorizes, so changed scope invalidates the
cursor; forged positions can skip rows only inside the authorized set.
