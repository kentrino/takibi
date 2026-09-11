# Anonymous and protected actions

`resolve` is the single trust boundary for storage-partition selection. When an
application allows anonymous callers, `resolve` returns a nullable identity
(for example `user: User | null`) instead of throwing. Action-level AuthN then
uses `.use()` to refine that context for protected handlers.

Collection CRUD `accessPolicy` still receives the base context from `resolve`.
Allowing an anonymous action does not open CRUD; grant those operations
explicitly, or keep them staff-only.

```ts
import { UnauthorizedError, createTakibi, fullAccess, grant, none } from "@takibi/takibi";
import { z } from "zod";

type User = { id: string; role: "staff" | "member" };
type AppCtx = { tenantId: string; user: User | null };
type AuthedCtx = { tenantId: string; user: User };

const requireUser = (ctx: AppCtx): AuthedCtx => {
  if (ctx.user == null) throw new UnauthorizedError("Sign in required");
  return { tenantId: ctx.tenantId, user: ctx.user };
};

const createContext = createTakibi();
const context = createContext({
  resolve: ({ request }): AppCtx => {
    // Prefer a trusted session / gateway assertion. Client-declared tenant
    // headers alone must not select the storage partition.
    const session = readSession(request);
    return {
      tenantId: session?.tenantId ?? "public",
      user: session?.user ?? null,
    };
  },
});

const publicInvoke = grant("invoke");
const staffCrud = context.policy(({ user }: AppCtx) =>
  user?.role === "staff" ? fullAccess : none,
);

const bookingSchema = z.object({
  title: z.string().min(1),
  status: z.enum(["pending", "accepted"]),
});

const bookings = context.defineCollection({
  schema: bookingSchema,
  accessPolicy: staffCrud,
});
const app = context.defineCollections({ bookings });

const bookingsActions = app.bookings.actions((defineAction) => ({
  // Anonymous OK — no use(). ctx.user is User | null.
  submit: defineAction()
    .detached()
    .input(z.object({ title: z.string().min(1) }))
    .atomic()
    .policy(publicInvoke)
    .handler(async ({ ctx, input, $collection }) => {
      return $collection.add({
        title: `${input.title}:${ctx.user?.id ?? "anon"}`,
        status: "pending",
      });
    }),

  // Auth required — use() narrows ctx.user to User for the gate and handler.
  accept: defineAction()
    .use(requireUser)
    .atomic()
    .policy(({ ctx }) => (ctx.user.role === "staff" ? grant("invoke") : none))
    .handler(async ({ ctx, id, $collection }) => {
      return $collection.update(id, {
        status: "accepted",
        title: `accepted-by:${ctx.user.id}`,
      });
    }),
}));

const handler = app.actions({ bookings: bookingsActions });

declare function readSession(request: Request): { tenantId: string; user: User } | null;
```

## AuthN vs AuthZ status codes

| Failure                                               | Mechanism                        | Wire                 |
| ----------------------------------------------------- | -------------------------------- | -------------------- |
| No session / identity                                 | `use` throws `UnauthorizedError` | `UNAUTHORIZED` / 401 |
| Signed in, wrong role                                 | gate policy returns `none`       | `FORBIDDEN` / 403    |
| Partition / credential rejected for the whole request | throw from `resolve`             | `UNAUTHORIZED` / 401 |

Guards run before document load, so an anonymous caller of a protected document
action receives 401 even when the id does not exist.

## Optional: 401 on anonymous CRUD

CRUD `accessPolicy` denial is normally `FORBIDDEN` / 403. Applications that
want anonymous collection reads to look like AuthN failures can throw
`UnauthorizedError` inside `accessPolicy` when `user == null`. Prefer that only
when the product intentionally treats “not signed in” differently from “signed
in but not allowed.”
