import { createClient } from "@takibi/takibi/client";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import {
  and,
  createTakibi,
  fullAccess,
  grant,
  none,
  or,
  type AccessContext,
  type PolicyReason,
} from "../src/index";
import { denialReasonOf, evaluateAccessPolicy } from "../src/policy";

type TestContext = { user: { id: string } | null };

const createContext = createTakibi()({
  resolve: ({ request }): TestContext => ({
    user: request.headers.get("authorization") === "admin" ? { id: "u1" } : null,
  }),
});

const itemSchema = z.object({ locked: z.boolean() });
const accessContext: AccessContext<
  TestContext,
  { id: string; createdAt: string; updatedAt: string; locked: boolean }
> = {
  user: { id: "u1" },
  collection: "items",
  operation: "invoke",
  permission: "invoke",
  doc: {
    id: "item-1",
    createdAt: "",
    updatedAt: "",
    locked: true,
  },
};

test("schema-bound and context-only policies retain literal reason codes", async () => {
  const schemaBound = createContext.policy(
    {
      schema: itemSchema,
      reason: {
        code: "LOCKED_ITEM",
        description: "Locked items cannot be changed.",
      },
    },
    ({ doc }) => (doc?.locked ? none : fullAccess),
  );
  const contextOnly = createContext.policy({ reason: { code: "SIGN_IN_REQUIRED" } }, ({ user }) =>
    user ? fullAccess : none,
  );

  expectTypeOf<PolicyReason<"LOCKED_ITEM">["code"]>().toEqualTypeOf<"LOCKED_ITEM">();

  const schemaDecision = await evaluateAccessPolicy(schemaBound, accessContext);
  const contextDecision = await evaluateAccessPolicy(contextOnly, {
    ...accessContext,
    user: null,
  });
  expect(denialReasonOf(schemaDecision, "invoke")).toEqual({
    code: "LOCKED_ITEM",
    description: "Locked items cannot be changed.",
  });
  expect(denialReasonOf(contextDecision, "invoke")).toEqual({
    code: "SIGN_IN_REQUIRED",
  });
});

test("and selects the first denying policy and keeps short-circuit order", async () => {
  const calls: string[] = [];
  const firstDenied = createContext.policy({ reason: { code: "FIRST_DENIAL" } }, () => {
    calls.push("first");
    return none;
  });
  const secondDenied = createContext.policy({ reason: { code: "SECOND_DENIAL" } }, () => {
    calls.push("second");
    return none;
  });
  const firstDecision = await evaluateAccessPolicy(and(firstDenied, secondDenied), accessContext);
  expect(denialReasonOf(firstDecision, "invoke")).toEqual({ code: "FIRST_DENIAL" });
  expect(calls).toEqual(["first"]);

  const laterDecision = await evaluateAccessPolicy(
    and(
      createContext.policy({ reason: { code: "ALLOWING_POLICY" } }, () => fullAccess),
      secondDenied,
    ),
    accessContext,
  );
  expect(denialReasonOf(laterDecision, "invoke")).toEqual({ code: "SECOND_DENIAL" });

  const reasonlessDecision = await evaluateAccessPolicy(
    and(
      createContext.policy(() => none),
      createContext.policy({ reason: { code: "MUST_NOT_FALL_BACK" } }, () => none),
    ),
    accessContext,
  );
  expect(denialReasonOf(reasonlessDecision, "invoke")).toBeUndefined();
});

test("or selects the first policy only when every policy denies", async () => {
  const firstDenied = createContext.policy({ reason: { code: "FIRST_DENIAL" } }, () => none);
  const secondDenied = createContext.policy({ reason: { code: "SECOND_DENIAL" } }, () => none);
  const denied = await evaluateAccessPolicy(or(firstDenied, secondDenied), accessContext);
  expect(denialReasonOf(denied, "invoke")).toEqual({ code: "FIRST_DENIAL" });

  const reasonless = await evaluateAccessPolicy(
    or(
      createContext.policy(() => none),
      secondDenied,
    ),
    accessContext,
  );
  expect(denialReasonOf(reasonless, "invoke")).toBeUndefined();

  const partiallyAllowed = await evaluateAccessPolicy(
    or(
      firstDenied,
      createContext.policy(() => grant("invoke")),
    ),
    accessContext,
  );
  expect(denialReasonOf(partiallyAllowed, "invoke")).toBeUndefined();

  const calls: string[] = [];
  await evaluateAccessPolicy(
    or(
      createContext.policy(() => {
        calls.push("first");
        return fullAccess;
      }),
      createContext.policy(() => {
        calls.push("second");
        return none;
      }),
    ),
    accessContext,
  );
  expect(calls).toEqual(["first"]);
});

function createReasonHandler() {
  const guarded = createContext.policy(
    { reason: { code: "ADMIN_REQUIRED", description: "An administrator is required." } },
    ({ user }) => (user ? fullAccess : none),
  );
  const locked = createContext.policy(
    {
      schema: itemSchema,
      reason: { code: "LOCKED_ITEM" },
    },
    ({ doc }) => (doc?.locked ? grant("get", "list") : fullAccess),
  );
  const app = createContext.defineCollections(
    {
      items: { schema: itemSchema, accessPolicy: guarded },
    },
    { memory: true },
  );
  const actions = app.items.actions((defineAction) => ({
    archive: defineAction()
      .policy(and(guarded, locked))
      .handler(({ id }) => ({ id })),
  }));
  return app.actions({ items: actions });
}

test("public failures serialize reason only on unconcealed FORBIDDEN paths", async () => {
  const handler = createReasonHandler();
  const admin = createClient<typeof handler>("http://takibi.test", {
    fetch: handler.request,
    headers: { authorization: "admin" },
  });
  const anonymous = createClient<typeof handler>("http://takibi.test", {
    fetch: handler.request,
  });
  const created = await admin.items.add({ locked: true }, { id: "locked" });
  expect(created.ok).toBe(true);

  const actionDenied = await admin.items.archive("locked");
  expect(actionDenied).toEqual({
    ok: false,
    error: {
      kind: "operation",
      code: "FORBIDDEN",
      message: "Forbidden",
      status: 403,
      reason: { code: "LOCKED_ITEM" },
    },
  });
  const missingAction = await admin.items.archive("missing");
  expect(missingAction).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "NOT_FOUND", status: 404 },
  });
  if (!missingAction.ok) expect(missingAction.error).not.toHaveProperty("reason");

  const deniedAdd = await anonymous.items.add({ locked: false });
  const deniedList = await anonymous.items.list();
  for (const result of [deniedAdd, deniedList]) {
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "operation",
        code: "FORBIDDEN",
        status: 403,
        reason: { code: "ADMIN_REQUIRED" },
      },
    });
  }
});

test("concealed existing and missing document responses are byte-equivalent", async () => {
  const existingHandler = createReasonHandler();
  const missingHandler = createReasonHandler();
  const admin = createClient<typeof existingHandler>("http://takibi.test", {
    fetch: existingHandler.request,
    headers: { authorization: "admin" },
  });
  await admin.items.add({ locked: true }, { id: "same-id" });

  const deniedExisting = await createClient<typeof existingHandler>("http://takibi.test", {
    fetch: existingHandler.request,
  }).items.get("same-id");
  const missing = await createClient<typeof missingHandler>("http://takibi.test", {
    fetch: missingHandler.request,
  }).items.get("same-id");

  expect(JSON.stringify(deniedExisting)).toBe(JSON.stringify(missing));
  if (!deniedExisting.ok) expect(deniedExisting.error).not.toHaveProperty("reason");
  if (!missing.ok) expect(missing.error).not.toHaveProperty("reason");
});
