import { expect, test } from "vite-plus/test";
import { z } from "zod";
import type {
  ActionGateContext,
  DocumentGateContext,
  RuntimeActionDefinition,
} from "@takibi/takibi-api";
import { createPolicyHelper, fullAccess } from "@takibi/takibi-policy";
import { resolveGateGrant, type ActionInvocation } from "../src/action-gate";

const invocation: ActionInvocation = {
  kind: "action",
  scope: "posts",
  name: "publish",
  id: "post-1",
};

const documentContext: ActionGateContext<unknown> = {
  ctx: { tenantId: "tenant-1" },
  scope: { kind: "collection", name: "posts" },
  invocation: { kind: "action", name: "publish" },
  permission: "invoke",
  target: { id: "post-1", doc: { title: "Draft" } },
};

function actionDefinition(
  policy: unknown,
  options: Pick<RuntimeActionDefinition, "kind" | "target"> = {
    kind: "collection",
    target: "document",
  },
): RuntimeActionDefinition {
  return {
    ...options,
    inputSchema: undefined,
    permission: "invoke",
    atomic: false,
    guards: [],
    policy: policy as RuntimeActionDefinition["policy"],
    handler: () => null,
  };
}

test("schema-bound gates receive a required document target", async () => {
  const policy = createPolicyHelper<{ tenantId: string }>()(
    z.object({ title: z.string() }),
    (context) => {
      expect(context).toMatchObject({
        tenantId: "tenant-1",
        collection: "posts",
        operation: "invoke",
        permission: "invoke",
        doc: { title: "Draft" },
      });
      return fullAccess;
    },
  );

  await expect(
    resolveGateGrant(
      actionDefinition(policy),
      { tenantId: "tenant-1" },
      invocation,
      documentContext,
      { title: "Draft" },
    ),
  ).resolves.toBe(fullAccess);
});

test("document, collection, and root action gates receive distinct contexts", async () => {
  const documentPolicy = (context: DocumentGateContext<unknown, unknown>) => {
    expect(context.target).toEqual({ id: "post-1", doc: { title: "Draft" } });
    return fullAccess;
  };
  await resolveGateGrant(
    actionDefinition(documentPolicy),
    {},
    invocation,
    documentContext,
    documentContext.target?.doc,
  );

  const detachedContext: ActionGateContext<unknown> = {
    ctx: {},
    scope: { kind: "root" },
    invocation: { kind: "action", name: "reindex" },
    permission: "invoke",
  };
  const detachedPolicy = (context: ActionGateContext<unknown, never>) => {
    expect(context.target).toBeUndefined();
    return fullAccess;
  };
  await resolveGateGrant(
    actionDefinition(detachedPolicy, { kind: "collection", target: "detached" }),
    {},
    { kind: "action", scope: "posts", name: "reindex" },
    { ...detachedContext, scope: { kind: "collection", name: "posts" } },
    undefined,
  );
  await resolveGateGrant(
    actionDefinition(detachedPolicy, { kind: "root", target: "detached" }),
    {},
    { kind: "action", scope: "$", name: "reindex" },
    detachedContext,
    undefined,
  );
});

test("public gate evaluation rejects invalid target combinations", async () => {
  const policy = createPolicyHelper<object>()(z.object({ title: z.string() }), () => fullAccess);
  await expect(
    resolveGateGrant(actionDefinition(policy), {}, invocation, documentContext, undefined),
  ).rejects.toThrow(/Schema-bound policies require a document action gate/);
  await expect(
    resolveGateGrant(
      actionDefinition(policy, { kind: "root", target: "detached" }),
      {},
      { kind: "action", scope: "$", name: "publish" },
      documentContext,
      { title: "Draft" },
    ),
  ).rejects.toThrow(/Detached and root action gates cannot have a document target/);
});
