import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import {
  and,
  or,
  grant,
  none,
  read,
  fullAccess,
  listDecisionOf,
  allows,
  createPolicyHelper,
  denialReasonOf,
} from "@takibi/policy";
import type { AccessContext, AccessGrant } from "@takibi/policy";
import { listWhere, composeAnd, composeOr, ListScopeError } from "@takibi/query";

const schema = z.object({ owner: z.string() });
const scope = (owner: string) => listWhere<z.infer<typeof schema>>((q) => q.owner.eq(owner));
const a = scope("a");
const b = scope("b");
const ctx: AccessContext<object> = { collection: "posts", operation: "list", permission: "list" };

test("list decisions implement every AND/OR truth-table cell", async () => {
  const grants = [none, read, grant(a)];
  const andKinds = [
    ["deny", "deny", "deny"],
    ["deny", "allowAll", "allowWhere"],
    ["deny", "allowWhere", "allowWhere"],
  ];
  const orKinds = [
    ["deny", "allowAll", "allowWhere"],
    ["allowAll", "allowAll", "allowAll"],
    ["allowWhere", "allowAll", "allowWhere"],
  ];
  for (const [i, left] of grants.entries())
    for (const [j, right] of grants.entries()) {
      const intersection = await and(left, right)(ctx);
      const union = await or(left, right)(ctx);
      expect(listDecisionOf(intersection).kind).toBe(andKinds[i]![j]);
      expect(listDecisionOf(union).kind).toBe(orKinds[i]![j]);
      expect(allows(intersection, "list")).toBe(andKinds[i]![j] !== "deny");
      expect(allows(union, "list")).toBe(orKinds[i]![j] !== "deny");
    }
  expect(listDecisionOf(await and(grant(a), grant(b))(ctx))).toEqual({
    kind: "allowWhere",
    where: composeAnd(a.where, b.where),
  });
  expect(listDecisionOf(await or(grant(a), grant(b))(ctx))).toEqual({
    kind: "allowWhere",
    where: composeOr(a.where, b.where),
  });
});

test("grant tokens, catalog overloads and policy folds keep their exact grouping", async () => {
  const c = scope("c");
  expect(listDecisionOf(grant(a, b, c))).toEqual({
    kind: "allowWhere",
    where: composeAnd(a.where, b.where, c.where),
  });
  expect(listDecisionOf(await and(grant(a), grant(b), grant(c))(ctx))).toEqual({
    kind: "allowWhere",
    where: composeAnd(composeAnd(a.where, b.where), c.where),
  });
  expect(listDecisionOf(grant((g) => [g.get, a]))).toEqual(listDecisionOf(grant("get", a)));
  expect(() => grant(a, "list", b)).toThrow(ListScopeError);
  expect(() => grant("list", a)).toThrow(ListScopeError);
  expect(() => grant((g) => [g.list, a])).toThrow(ListScopeError);
  expect(listDecisionOf(grant("list"))).toEqual({ kind: "allowAll" });
  expect(listDecisionOf(await and(grant("list"), grant(a))(ctx))).toEqual(listDecisionOf(grant(a)));
  expect(() => grant("list", { ...a })).toThrow(ListScopeError);
  expect(() => listDecisionOf({} as AccessGrant)).toThrow(ListScopeError);
});

test("scoped full permissions do not intern or short circuit a later widening branch", async () => {
  const scopedFull = grant("create", "get", "update", "delete", "invoke", a);
  const later = vi.fn(() => read);
  expect(await or(scopedFull, later)(ctx)).toBe(fullAccess);
  expect(later).toHaveBeenCalledTimes(1);
  expect(listDecisionOf(await or(scopedFull, none)(ctx)).kind).toBe("allowWhere");
  const skipped = vi.fn(() => {
    throw new Error("not evaluated");
  });
  expect(await or(fullAccess, skipped)(ctx)).toBe(fullAccess);
  expect(await and(none, skipped)(ctx)).toBe(none);
  expect(skipped).not.toHaveBeenCalled();
  expect(listDecisionOf(await or(grant("update"), grant(a))(ctx))).toEqual(
    listDecisionOf(grant(a)),
  );
});

test("static denial reasons preserve ranges and eager overflow cannot be absorbed later", async () => {
  const policy = createPolicyHelper<object>();
  const wrapped = policy({ reason: { code: "OWNER" } }, grant(a));
  const decision = await wrapped(ctx);
  expect(listDecisionOf(decision)).toEqual(listDecisionOf(grant(a)));
  expect(denialReasonOf(decision, "update")).toEqual({ code: "OWNER" });
  const many = Array<AccessGrant>(17).fill(grant(a));
  const overflowing = and(many[0]!, ...many.slice(1));
  await expect(or(overflowing, read)(ctx)).rejects.toThrow(ListScopeError);
  await expect(and(overflowing, none)(ctx)).rejects.toThrow(ListScopeError);
});

test("schema-derived scope callbacks reject unknown fields at compile time", () => {
  const check = () =>
    listWhere<z.infer<typeof schema>>((q) => {
      // @ts-expect-error unknown schema field
      return q.missing.eq("x");
    });
  expect(check).toBeTypeOf("function");
});
