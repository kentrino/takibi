import type { RuntimeActionDefinition } from "@takibi/takibi-api";
import type { ExecutionPlan, TransactionBoundary } from "@takibi/takibi-worker-runtime-contract";
import type { ExecuteRequest } from "./executor";
import type { TakibiActionWork, TakibiCollectionWork } from "./invocation-type-map";

export function actionTransactionBoundaryOf(
  definition: RuntimeActionDefinition,
): TransactionBoundary {
  const document = definition.kind === "collection" && definition.target === "document";
  if (document && definition.atomic) return "full";
  if (definition.atomic) return "apply";
  return "none";
}

export function collectionTransactionBoundaryOf(
  request: Pick<ExecuteRequest, "operation">,
): TransactionBoundary {
  return request.operation === "add" ? "apply" : "none";
}

export function actionExecutionPlan(
  work: TakibiActionWork,
): ExecutionPlan<TakibiActionWork, TakibiActionWork, TakibiActionWork> {
  const transactionBoundary = actionTransactionBoundaryOf(work.definition);
  if (transactionBoundary === "full") return { transactionBoundary, work };
  if (transactionBoundary === "apply") return { transactionBoundary, work };
  return { transactionBoundary, work };
}

export function collectionExecutionPlan(
  work: TakibiCollectionWork,
): ExecutionPlan<TakibiCollectionWork, TakibiCollectionWork, never> {
  const transactionBoundary = collectionTransactionBoundaryOf(work.request);
  if (transactionBoundary === "apply") return { transactionBoundary, work };
  return { transactionBoundary: "none", work };
}
