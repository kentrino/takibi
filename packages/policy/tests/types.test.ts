import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import {
  and,
  createPolicyHelper,
  fullAccess,
  none,
  type AccessContext,
  type AccessGrant,
  type AccessPermission,
  type AccessPolicy,
  type ConstrainedPolicy,
  type InferPolicyDoc,
  type PolicyReason,
  type PolicyReasonCodeOf,
} from "../src";
import type { WithMetadata } from "@takibi/shared-types";

type User = { id: string } | null;
type AppCtx = { tenantId: string; user: User };

test("AccessGrant stays opaque and is not a Set-like public value", () => {
  expectTypeOf<AccessGrant>().not.toHaveProperty("has");
  expectTypeOf<AccessGrant>().not.toHaveProperty("size");
  expectTypeOf<AccessGrant>().not.toMatchTypeOf<ReadonlySet<AccessPermission>>();
  {
    const grantValue: AccessGrant = none;
    // @ts-expect-error opaque grant is not a ReadonlySet
    const _set: ReadonlySet<AccessPermission> = grantValue;
    void _set;
  }
});

test("AccessContext preserves application context keys without defining their vocabulary", () => {
  expectTypeOf<AccessContext<AppCtx>["user"]>().toEqualTypeOf<AppCtx["user"]>();
  expectTypeOf<AccessContext<AppCtx>["tenantId"]>().toEqualTypeOf<AppCtx["tenantId"]>();
  expectTypeOf<AccessContext<{ foo: string }>["foo"]>().toEqualTypeOf<string>();
});

test("createPolicyHelper keeps schema and context-only overloads", () => {
  const helper = createPolicyHelper<AppCtx>();
  const staff = helper(({ user }) => {
    expectTypeOf(user).toEqualTypeOf<User>();
    return user ? fullAccess : none;
  });
  const ownerOnly = helper(z.object({ ownerId: z.string() }), ({ user, doc }) => {
    expectTypeOf(user).toEqualTypeOf<User>();
    return user?.id === doc?.ownerId ? fullAccess : none;
  });
  void staff;
  void ownerOnly;
});

test("schema-bound policy requires pick keys on the collection document", () => {
  const helper = createPolicyHelper<AppCtx>();
  const seeded = helper(z.object({ isSeed: z.boolean() }), ({ doc }) =>
    doc?.isSeed === true ? none : fullAccess,
  );
  const staff = helper(({ user }) => (user ? fullAccess : none));

  type Items = WithMetadata<{ name: string; isSeed: boolean }>;
  type OptionalSeed = WithMetadata<{ name: string; isSeed?: boolean }>;
  type Bare = WithMetadata<{ name: string }>;

  const onRequired: AccessPolicy<AppCtx, Items> = seeded;
  const onOptional: AccessPolicy<AppCtx, OptionalSeed> = seeded;
  const composed: AccessPolicy<AppCtx, Items> = and(staff, seeded);
  void onRequired;
  void onOptional;
  void composed;

  const rejectMissing = (policy: AccessPolicy<AppCtx, Bare>) => policy;
  // @ts-expect-error schema-bound policy keys must exist on the collection document
  rejectMissing(seeded);
  // @ts-expect-error and() preserves the schema-bound key constraint
  rejectMissing(and(staff, seeded));
});

test("reason-code union inference flows through composed policies", () => {
  const helper = createPolicyHelper<AppCtx>();
  const first = helper({ reason: { code: "FIRST_DENIAL" } }, () => none);
  const second = helper({ reason: { code: "SECOND_DENIAL" } }, () => none);
  const schemaBound = helper(
    { schema: z.object({ locked: z.boolean() }), reason: { code: "LOCKED_ITEM" } },
    () => none,
  );

  expectTypeOf<PolicyReason<"LOCKED_ITEM">["code"]>().toEqualTypeOf<"LOCKED_ITEM">();
  expectTypeOf<PolicyReasonCodeOf<typeof first>>().toEqualTypeOf<"FIRST_DENIAL">();
  expectTypeOf<PolicyReasonCodeOf<typeof schemaBound>>().toEqualTypeOf<"LOCKED_ITEM">();

  const composed = and(first, second, schemaBound);
  expectTypeOf<PolicyReasonCodeOf<typeof composed>>().toEqualTypeOf<
    "FIRST_DENIAL" | "SECOND_DENIAL" | "LOCKED_ITEM"
  >();
});

test("InferPolicyDoc adds transport metadata without copying policy-local document types", () => {
  const schema = z.object({ title: z.string() });
  expectTypeOf<InferPolicyDoc<typeof schema>>().toMatchTypeOf<{
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  }>();
  expectTypeOf<ConstrainedPolicy<AppCtx, InferPolicyDoc<typeof schema>>>().not.toBeNever();
});
