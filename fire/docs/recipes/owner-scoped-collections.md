# Owner-scoped collection policy

Document ownership is application domain data. Keep the owner field in the
collection schema and define its semantics in an application-local policy
instead of treating it as library-managed metadata.

The following policy lets an owner create, read, update, and delete notes while
preventing owner reassignment. Administrators bypass the restriction.

```ts
import { fire, fullAccess, grant, none, queryImpliesEquality } from "@takibi/fire";
import { z } from "zod";

type User = {
  id: string;
  role: "admin" | "member";
};

const noteSchema = z.object({
  ownerId: z.string().min(1),
  title: z.string(),
});

const createContext = fire.initialContext();
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

const handler = context.collections({
  notes: {
    schema: noteSchema,
    accessPolicy: noteOwnerPolicy,
  },
});
```

Clients must send `ownerId`; fire does not insert it. Trusted
`handler.$collections` and Durable Object `$collections` calls bypass
`accessPolicy`, but schema validation still applies.

The member policy grants `list` only when the complete query implies
`ownerId.eq(user.id)`. This accepts `and(ownerId.eq(user.id), ...)` and rejects
an absent query, another owner value, `or(ownerId.eq(user.id), ...)`, and
`not(ownerId.eq(other))`. Filtering runs in trusted server storage before the
response is built, so unrelated documents are not returned to the client. The
initial implementation scans the collection without an index; account for that
linear cost when choosing collection size.

For a different owner field such as `authorId`, pick and compare that field
instead. If ownership transfer is valid in the domain, model it as a separate
privileged action rather than weakening the ordinary update rule.
