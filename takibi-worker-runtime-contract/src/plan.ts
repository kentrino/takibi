import { TakibiContractConfigurationError } from "./request";
import type { CollectionOperation } from "@takibi/takibi-shared-types";
import type { ExecutionPlan, TransactionBoundary } from "./type";

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

export function transactionBoundaryOf(criteria: TransactionPlanCriteria): TransactionBoundary {
  if (criteria.kind === "action") {
    if (criteria.target === "document" && criteria.atomic) return "full";
    if (criteria.atomic) return "apply";
    return "none";
  }
  return criteria.operation === "add" ? "apply" : "none";
}

export function createActionExecutionPlan<TWork>(
  criteria: Extract<ActionPlanCriteria, { target: "document"; atomic: true }>,
  work: TWork,
): Extract<ExecutionPlan<TWork, TWork, TWork>, { transactionBoundary: "full" }>;
export function createActionExecutionPlan<TWork>(
  criteria: Extract<ActionPlanCriteria, { atomic: true }>,
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
  criteria: Extract<CollectionPlanCriteria, { operation: "add" }>,
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
  if (transactionBoundary === "full") {
    throw new TakibiContractConfigurationError("Collection plans cannot use the full boundary");
  }
  if (transactionBoundary === "apply") return { transactionBoundary, work };
  return { transactionBoundary: "none", work };
}
