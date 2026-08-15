# Owner-scoped collection policy

Document ownership is application domain data. Keep the owner field in the
collection schema and define its semantics in an application-local policy
instead of treating it as library-managed metadata.

The following policy lets an owner create, read, update, and delete notes while
preventing owner reassignment. Administrators bypass the restriction.

```ts
import { fire, grant, none, write } from "@takibi/fire";
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
  ({ user, operation, doc, nextDoc }) => {
    if (user?.role === "admin") return write;
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
        return none;
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

The member policy deliberately denies `list`. The current list API cannot query
by owner, and fetching the whole collection before filtering can expose data
and scales poorly. Provide owner-scoped listing only through an indexed query
or a server-side action that never reads unrelated documents.

For a different owner field such as `authorId`, pick and compare that field
instead. If ownership transfer is valid in the domain, model it as a separate
privileged action rather than weakening the ordinary update rule.
