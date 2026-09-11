import { requestTakibi } from "./helpers/request";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createClient } from "@takibi/takibi/client";
import { createPolicyHelper } from "@takibi/takibi-policy";
import { withSqliteTestBackend } from "@takibi/takibi/testing";
import { createTakibi, fullAccess, grant, none, UnauthorizedError } from "../src/index";

type User = { id: string; role: "staff" | "member" };
type AppCtx = { tenantId: string; user: User | null };
type AuthedCtx = { tenantId: string; user: User };

function resolveTestContext({ request }: { request: Request }): AppCtx {
  const raw = request.headers.get("x-test-user");
  return {
    tenantId: request.headers.get("x-test-tenant") ?? "tenant-a",
    user: raw ? (JSON.parse(raw) as User) : null,
  };
}

function headers(user: User | null): Headers {
  const value = new Headers({ "x-test-tenant": "tenant-a" });
  if (user) value.set("x-test-user", JSON.stringify(user));
  return value;
}

const requireUser = (ctx: AppCtx): AuthedCtx => {
  if (ctx.user == null) throw new UnauthorizedError("Sign in required");
  return { tenantId: ctx.tenantId, user: ctx.user };
};

const requireStaff = (ctx: AuthedCtx): AuthedCtx => {
  if (ctx.user.role !== "staff") throw new UnauthorizedError("Staff only");
  return ctx;
};

const Booking = z.object({
  title: z.string().min(1),
  status: z.enum(["pending", "accepted"]),
});

function createApp() {
  const context = createTakibi()({ resolve: resolveTestContext });
  const publicInvoke = grant("invoke");
  const staffCrud = context.policy(({ user }: AppCtx) =>
    user?.role === "staff" ? fullAccess : none,
  );

  const bookings = context.defineCollection({
    schema: Booking,
    accessPolicy: staffCrud,
    seed: () => ({
      b1: { title: "existing", status: "pending" as const },
    }),
  });
  const app = context.defineCollections({ bookings });

  const bookingsActions = app.bookings.actions((defineAction) => ({
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
    accept: defineAction()
      .use(requireUser)
      .input(z.object({ note: z.string().optional() }))
      .atomic()
      .policy(({ ctx }) => (ctx.user.role === "staff" ? grant("invoke") : none))
      .handler(async ({ ctx, id, $collection }) => {
        return $collection.update(id, {
          status: "accepted",
          title: `accepted-by:${ctx.user.id}`,
        });
      }),
    staffOnly: defineAction()
      .use(requireUser)
      .use(requireStaff)
      .detached()
      .policy(publicInvoke)
      .handler(({ ctx }) => ({ role: ctx.user.role })),
  }));

  const handler = withSqliteTestBackend(app.actions({ bookings: bookingsActions }));
  return { handler };
}

function clientFor(handler: ReturnType<typeof createApp>["handler"], user: User | null) {
  return createClient<typeof handler>("http://fire.test", {
    headers: () => headers(user),
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
}

test("anonymous caller can run a public action without use()", async () => {
  const { handler } = createApp();
  const anonymous = clientFor(handler, null);
  const result = await anonymous.bookings.submit({ title: "walk-in" });
  expect(result).toMatchObject({
    ok: true,
    data: { title: "walk-in:anon", status: "pending" },
  });
});

test("anonymous caller gets UNAUTHORIZED on a use(requireUser) action", async () => {
  const { handler } = createApp();
  const anonymous = clientFor(handler, null);
  expect(await anonymous.bookings.accept("b1", {})).toMatchObject({
    ok: false,
    error: { code: "UNAUTHORIZED", status: 401 },
  });
});

test("authenticated non-staff gets FORBIDDEN from the gate, not 401", async () => {
  const { handler } = createApp();
  const member = clientFor(handler, { id: "m1", role: "member" });
  expect(await member.bookings.accept("b1", {})).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
});

test("staff caller succeeds on an authenticated action", async () => {
  const { handler } = createApp();
  const staff = clientFor(handler, { id: "s1", role: "staff" });
  expect(await staff.bookings.accept("b1", {})).toMatchObject({
    ok: true,
    data: { status: "accepted", title: "accepted-by:s1" },
  });
});

test("anonymous document action with missing id still returns 401 before NOT_FOUND", async () => {
  const { handler } = createApp();
  const anonymous = clientFor(handler, null);
  expect(await anonymous.bookings.accept("missing-id", {})).toMatchObject({
    ok: false,
    error: { code: "UNAUTHORIZED", status: 401 },
  });
});

test("multiple use() guards run in declaration order", async () => {
  const { handler } = createApp();
  const member = clientFor(handler, { id: "m1", role: "member" });
  // First guard authenticates; second throws UnauthorizedError for non-staff.
  expect(await member.bookings.staffOnly()).toMatchObject({
    ok: false,
    error: { code: "UNAUTHORIZED", status: 401, message: "Staff only" },
  });

  const staff = clientFor(handler, { id: "s1", role: "staff" });
  expect(await staff.bookings.staffOnly()).toEqual({
    ok: true,
    data: { role: "staff" },
  });
});

test("anonymous CRUD stays denied when accessPolicy does not grant", async () => {
  const { handler } = createApp();
  const anonymous = clientFor(handler, null);
  expect(await anonymous.bookings.list()).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
  // Concealment: denied get looks like missing, not FORBIDDEN.
  expect(await anonymous.bookings.get("b1")).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  expect(await anonymous.bookings.add({ title: "x", status: "pending" })).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
});

test("action guards replace gate and handler context while nested CRUD keeps resolve context", async () => {
  const baseContext: AppCtx = { tenantId: "tenant-a", user: { id: "s1", role: "staff" } };
  const context = createTakibi()({ resolve: () => baseContext });
  const policyContexts: AppCtx[] = [];
  const app = context.defineCollections({
    bookings: {
      schema: Booking,
      accessPolicy: context.policy((ctx) => {
        policyContexts.push(ctx);
        return ctx.tenantId === "tenant-a" && ctx.user?.role === "staff" ? fullAccess : none;
      }),
      seed: () => ({ b1: { title: "existing", status: "pending" as const } }),
    },
  });
  const schemaGate = createPolicyHelper<object>()(Booking, ({ doc }) =>
    doc?.status === "pending" ? fullAccess : none,
  );
  const bookings = app.bookings.actions((defineAction) => ({
    inspect: defineAction()
      .use(() => "guarded")
      .policy(({ ctx }) => (ctx === "guarded" ? fullAccess : none))
      .handler(async ({ ctx, collection, id }) => ({ ctx, booking: await collection.get(id) })),
    inspectWithSchemaGate: defineAction()
      .use(() => "guarded")
      .policy(schemaGate)
      .handler(({ ctx, id }) => ({ ctx, id })),
  }));
  const inspectRoot = app
    .defineAction()
    .use(() => "guarded")
    .use((identity) => ({ identity }))
    .policy(({ ctx }) => (ctx.identity === "guarded" ? fullAccess : none))
    .handler(async ({ ctx, collections }) => ({
      ctx,
      booking: await collections.bookings.get("b1"),
    }));
  const handler = withSqliteTestBackend(app.actions({ bookings, $: { inspectRoot } }));
  const client = createClient<typeof handler>("http://fire.test", {
    fetch: (input, init) => requestTakibi(handler, input, init),
  });

  expect(await client.bookings.inspect("b1")).toMatchObject({
    ok: true,
    data: { ctx: "guarded", booking: { title: "existing" } },
  });
  expect(await client.inspectRoot()).toMatchObject({
    ok: true,
    data: { ctx: { identity: "guarded" }, booking: { title: "existing" } },
  });
  expect(await client.bookings.inspectWithSchemaGate("b1")).toEqual({
    ok: true,
    data: { ctx: "guarded", id: "b1" },
  });
  expect(policyContexts).toMatchObject([baseContext, baseContext]);
});
