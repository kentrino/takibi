import {
  createActionExecutionPlan,
  createCollectionExecutionPlan,
} from "@takibi/worker-runtime-contract";
import type { ClassifiedAction } from "./action-resolution";
import type { ExecuteRequest } from "@takibi/operations";
import type { TakibiActionWork, TakibiCollectionWork } from "./invocation-type-map";

export function createTakibiActionPlan(classified: ClassifiedAction) {
  const { definition } = classified;
  const work: TakibiActionWork = { kind: "action", ...classified };
  return createActionExecutionPlan(
    { kind: "action", target: definition.target, atomic: definition.atomic },
    work,
  );
}

export function createTakibiCollectionPlan(request: ExecuteRequest) {
  const work: TakibiCollectionWork = { kind: "collection", request };
  return createCollectionExecutionPlan({ kind: "collection", operation: request.operation }, work);
}
