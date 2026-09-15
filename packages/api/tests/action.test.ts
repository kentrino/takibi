import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import {
  ActionRegistry,
  assertCollectionName,
  assertNoActionsOption,
  createDocumentActionBuilder,
  createRootActionBuilder,
  defineCollection,
  type ActionDefinitions,
  type RuntimeActionDefinition,
} from "@takibi/api";
import { createPolicyHelper, fullAccess, grant } from "@takibi/policy";

test("registered actions use the unknown-based runtime definition", () => {
  const definition = createRootActionBuilder()
    .policy(fullAccess)
    .handler(() => ({ ok: true as const }));
  const registry = new ActionRegistry();
  registry.registerRootActions({ ping: definition }, new Set());
  const registered = registry.get("$", "ping");
  expect(registered?.definition.target).toBe("detached");
  expectTypeOf<RuntimeActionDefinition["target"]>().toEqualTypeOf<"document" | "detached">();
  expectTypeOf<Parameters<RuntimeActionDefinition["handler"]>[0]>().toEqualTypeOf<unknown>();
});

test("ActionRegistry rejects collisions, reserved names, and invalid definitions", () => {
  const valid = createRootActionBuilder()
    .policy(fullAccess)
    .handler(() => ({ ok: true }));
  const registry = new ActionRegistry();
  const collectionNames = new Set(["posts"]);
  const register = (definitions: ActionDefinitions) =>
    registry.registerRootActions(definitions, collectionNames);

  expect(() => register({ valid, invalid: { ...valid, kind: "collection" } as never })).toThrow(
    /Invalid root action/,
  );
  expect(() => register({ posts: valid })).toThrow(/reserved name/);
  expect(() => register({ bind: valid })).toThrow(/Invalid action name/);
  expect(() =>
    register({
      badPermission: { ...valid, permission: "admin" } as never,
    }),
  ).toThrow(/Invalid action permission/);
  expect(() =>
    register({
      badPolicy: { ...valid, policy: grant("admin" as never) } as never,
    }),
  ).toThrow(/Invalid list authorization scope/);
  expect(() =>
    register({
      badSchema: { ...valid, inputSchema: {} } as never,
    }),
  ).toThrow(/Invalid action input schema/);
  const hidden = {};
  Object.defineProperty(hidden, "hidden", {
    value: valid,
    enumerable: false,
  });
  expect(() => register(hidden as ActionDefinitions)).toThrow(/enumerable data properties/);
  expect(() => register({ [Symbol("hidden")]: valid } as ActionDefinitions)).toThrow(
    /names must be strings/,
  );
  register({ valid });
  expect(() => register({ valid })).toThrow(/already registered/);
  expect(registry.clone().get("$", "valid")?.name).toBe("valid");
});

test("scoped action maps are rejected when registered under another collection", () => {
  const posts = createDocumentActionBuilder<
    { tenantId: string },
    { id: string; doc: { title: string } },
    object,
    { title: string }
  >("posts")
    .policy(fullAccess)
    .handler(({ id }) => ({ id }));
  const registry = new ActionRegistry();
  expect(() => registry.registerCollectionActions("audits", { touch: posts })).toThrow(
    /defined for scope "posts" but registered under "audits"/,
  );
  registry.registerCollectionActions("posts", { touch: posts });
  expect(registry.get("posts", "touch")?.scope).toBe("posts");
});

test("detached and root actions reject schema-bound gate policies at registration", () => {
  const helper = createPolicyHelper<{ tenantId: string }>();
  const bound = helper(z.object({ title: z.string() }), () => fullAccess);
  const detached = createDocumentActionBuilder("posts")
    .detached()
    // @ts-expect-error schema-bound policies are excluded from detached gates
    .policy(bound)
    .handler(() => null);
  const root = createRootActionBuilder()
    // @ts-expect-error schema-bound policies are excluded from root gates
    .policy(bound)
    .handler(() => null);
  const registry = new ActionRegistry();
  expect(() => registry.registerCollectionActions("posts", { bad: detached })).toThrow(
    /Schema-bound policies require a document action gate/,
  );
  expect(() => registry.registerRootActions({ root }, new Set())).toThrow(
    /Schema-bound policies require a document action gate/,
  );
});

test("collection action definitions reject CRUD names and the legacy actions option", () => {
  expect(() =>
    defineCollection({
      schema: z.object({ title: z.string() }),
      accessPolicy: fullAccess,
      actions: () => ({}),
    } as never),
  ).toThrow(/no longer take actions/);
  expect(() => assertNoActionsOption({ actions: () => ({}) })).toThrow(/no longer take actions/);

  const crudNamed = createDocumentActionBuilder("posts")
    .detached()
    .policy(fullAccess)
    .handler(() => ({ bad: true }));
  const registry = new ActionRegistry();
  expect(() => registry.registerCollectionActions("posts", { get: crudNamed })).toThrow(
    /reserved name/,
  );
});

test("collection names reject reserved and unsafe public identifiers", () => {
  expect(() => assertCollectionName("then")).toThrow(/Invalid collection name/);
  expect(() => assertCollectionName("actions")).toThrow(/Invalid collection name/);
  expect(() => assertCollectionName("defineAction")).toThrow(/Invalid collection name/);
  expect(() => assertCollectionName("$")).toThrow(/Invalid collection name/);
  expect(() => assertCollectionName("posts:v2")).toThrow(/Invalid collection name/);
  assertCollectionName("posts");
});

test("builder branches retain metadata and detached methods retain their builder", () => {
  const base = createDocumentActionBuilder("posts");
  // Deliberately detach the method to verify the public fluent API remains callable.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { input } = base;
  const schema = z.object({ count: z.number() });
  const typed = input(schema);
  const { policy } = typed;
  const document = policy(fullAccess).handler(({ input }) => input);
  const detached = base
    .detached()
    .atomic()
    .policy(fullAccess)
    .handler(() => null);
  expect(document).toMatchObject({
    kind: "collection",
    target: "document",
    scope: "posts",
    atomic: false,
  });
  expect(document.inputSchema).toBe(schema);
  expect(detached).toMatchObject({
    kind: "collection",
    target: "detached",
    scope: "posts",
    atomic: true,
  });
  expect(detached.inputSchema).toBeUndefined();
  expect(Object.isFrozen(document)).toBe(true);
  expect(Object.isFrozen(document.guards)).toBe(true);
});
