import type { ExecutionPlan, TransactionBoundary } from "@takibi/invocation-lifecycle";
import type { CollectionOperation } from "@takibi/shared-types";

export type ActionPlanTarget = "document" | "detached";

export type ActionPlanCriteria = Readonly<{
  kind: "action";
  target: ActionPlanTarget;
  atomic: boolean;
}>;

export type CollectionPlanCriteria = Readonly<{
  kind: "collection";
  operation: CollectionOperation;
}>;

export type TransactionPlanCriteria = ActionPlanCriteria | CollectionPlanCriteria;

export function transactionBoundaryOf(criteria: CollectionPlanCriteria): "none" | "apply";
export function transactionBoundaryOf(criteria: TransactionPlanCriteria): TransactionBoundary;
export function transactionBoundaryOf(criteria: TransactionPlanCriteria): TransactionBoundary {
  if (criteria.kind === "action") {
    if (criteria.target === "document" && criteria.atomic) return "full";
    if (criteria.atomic) return "apply";
    return "none";
  }
  return criteria.operation === "add" ? "apply" : "none";
}

export function createActionExecutionPlan<TWork>(
  criteria: ActionPlanCriteria & { target: "document"; atomic: true },
  work: TWork,
): Extract<ExecutionPlan<TWork, TWork, TWork>, { transactionBoundary: "full" }>;
export function createActionExecutionPlan<TWork>(
  criteria: ActionPlanCriteria & { atomic: true },
  work: TWork,
): Extract<ExecutionPlan<TWork, TWork, TWork>, { transactionBoundary: "apply" | "full" }>;
export function createActionExecutionPlan<TWork>(
  criteria: ActionPlanCriteria,
  work: TWork,
): ExecutionPlan<TWork, TWork, TWork>;
export function createActionExecutionPlan<TWork>(
  criteria: ActionPlanCriteria,
  work: TWork,
): ExecutionPlan<TWork, TWork, TWork> {
  return { transactionBoundary: transactionBoundaryOf(criteria), work };
}

export function createCollectionExecutionPlan<TWork>(
  criteria: CollectionPlanCriteria & { operation: "add" },
  work: TWork,
): Extract<ExecutionPlan<TWork, TWork, never>, { transactionBoundary: "apply" }>;
export function createCollectionExecutionPlan<TWork>(
  criteria: CollectionPlanCriteria,
  work: TWork,
): Extract<ExecutionPlan<TWork, TWork, never>, { transactionBoundary: "none" | "apply" }>;
export function createCollectionExecutionPlan<TWork>(
  criteria: CollectionPlanCriteria,
  work: TWork,
): ExecutionPlan<TWork, TWork, never> {
  const transactionBoundary = transactionBoundaryOf(criteria);
  if (transactionBoundary === "apply") return { transactionBoundary, work };
  return { transactionBoundary: "none", work };
}
