import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createActionExecutionPlan,
  createCollectionExecutionPlan,
  transactionBoundaryOf,
  type ActionPlanCriteria,
  type CollectionPlanCriteria,
} from "../src/invocation-plan-contract";

test("action and collection criteria select the Takibi boundary table", () => {
  expect(transactionBoundaryOf({ kind: "action", target: "document", atomic: true })).toBe("full");
  expect(transactionBoundaryOf({ kind: "action", target: "detached", atomic: true })).toBe("apply");
  expect(transactionBoundaryOf({ kind: "action", target: "document", atomic: false })).toBe("none");
  expect(transactionBoundaryOf({ kind: "collection", operation: "add" })).toBe("apply");
  for (const operation of ["set", "get", "update", "delete", "list", "count"] as const) {
    expect(transactionBoundaryOf({ kind: "collection", operation })).toBe("full");
  }
});

test("plan builders pair the selected boundary with the supplied work", () => {
  const actionWork = { token: "action" };
  const collectionWork = { token: "collection" };
  expect(
    createActionExecutionPlan({ kind: "action", target: "document", atomic: true }, actionWork),
  ).toEqual({
    transactionBoundary: "full",
    work: actionWork,
  });
  expect(
    createCollectionExecutionPlan({ kind: "collection", operation: "add" }, collectionWork),
  ).toEqual({
    transactionBoundary: "apply",
    work: collectionWork,
  });
  expect(
    createCollectionExecutionPlan({ kind: "collection", operation: "get" }, collectionWork),
  ).toEqual({
    transactionBoundary: "full",
    work: collectionWork,
  });
});

test("collection criteria expose the complete collection boundary table", () => {
  const boundary = transactionBoundaryOf({ kind: "collection", operation: "get" });
  expectTypeOf(boundary).toEqualTypeOf<"apply" | "full">();
  expect(boundary).toBe("full");
});

test("specific criteria retain their execution boundary types", () => {
  const work = { token: "work" };
  const full = createActionExecutionPlan(
    { kind: "action", target: "document", atomic: true },
    work,
  );
  expectTypeOf(full.transactionBoundary).toEqualTypeOf<"full">();
  expectTypeOf(full.work).toEqualTypeOf<typeof work>();

  const atomic = (target: ActionPlanCriteria["target"]) =>
    createActionExecutionPlan({ kind: "action", target, atomic: true }, work);
  expectTypeOf<ReturnType<typeof atomic>["transactionBoundary"]>().toEqualTypeOf<
    "full" | "apply"
  >();

  const add = createCollectionExecutionPlan({ kind: "collection", operation: "add" }, work);
  expectTypeOf(add.transactionBoundary).toEqualTypeOf<"apply">();
  expectTypeOf(add.work).toEqualTypeOf<typeof work>();

  const generalAction = (criteria: ActionPlanCriteria) => createActionExecutionPlan(criteria, work);
  expectTypeOf<ReturnType<typeof generalAction>["transactionBoundary"]>().toEqualTypeOf<
    "none" | "apply" | "full"
  >();
  const generalCollection = (criteria: CollectionPlanCriteria) =>
    createCollectionExecutionPlan(criteria, work);
  expectTypeOf<ReturnType<typeof generalCollection>["transactionBoundary"]>().toEqualTypeOf<
    "apply" | "full"
  >();
});
