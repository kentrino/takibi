import {
  jsonResponseFromStatus,
  type InternalInvocationFailure,
  type InvocationResult,
} from "@takibi/takibi-worker-runtime-contract";
import { emitFailure, requestLogFields, type InternalLogger } from "./logging";
import { invocationFields, toWireFailure } from "./context/runtime";
import type { PublicRequest } from "./http";
import type { TakibiInvocationTypeMap } from "./invocation-type-map";
import type { WireFailure, WireResponse } from "./protocol";

type NotifiedInvocation<TContext extends object = object, TServices = unknown> = InvocationResult<
  TakibiInvocationTypeMap<TContext, TServices>
>;

type ResponseConverterDeps = {
  invocationRuntime: { readonly logger?: InternalLogger };
  localRequest: Request | undefined;
};

export function invocationToWireResponse(deps: ResponseConverterDeps) {
  return <TContext extends object, TServices>({
    invocation,
  }: {
    invocation: NotifiedInvocation<TContext, TServices>;
  }): WireResponse => {
    const { settlement } = invocation;
    if (settlement.outcome === "succeeded") {
      return { ok: true, data: settlement.result };
    }
    const wire = wireFailureFromSettlement(settlement.failure);
    emitFailure(deps.invocationRuntime.logger, wire.error, {
      ...publicInvocationFields(invocation.invocation),
      ...(deps.localRequest === undefined ? {} : requestLogFields(deps.localRequest)),
    });
    return wire;
  };
}

export function invocationToHttpResponse(deps: ResponseConverterDeps) {
  const toWire = invocationToWireResponse(deps);
  return <TContext extends object, TServices>({
    invocation,
  }: {
    invocation: NotifiedInvocation<TContext, TServices>;
  }): Response => {
    return jsonResponseFromStatus(toWire({ invocation }), Response);
  };
}

export function invocationsToBatchWireResponse(deps: ResponseConverterDeps) {
  const toWire = invocationToWireResponse(deps);
  return <TContext extends object, TServices>({
    invocations,
  }: {
    invocations: readonly NotifiedInvocation<TContext, TServices>[];
  }): WireResponse => ({
    ok: true,
    data: invocations.map((invocation) => toWire({ invocation })),
  });
}

export function invocationsToBatchHttpResponse(deps: ResponseConverterDeps) {
  const toWire = invocationsToBatchWireResponse(deps);
  return <TContext extends object, TServices>({
    invocations,
  }: {
    invocations: readonly NotifiedInvocation<TContext, TServices>[];
  }): Response => jsonResponseFromStatus(toWire({ invocations }), Response);
}

function wireFailureFromSettlement(failure: InternalInvocationFailure<WireFailure>): WireFailure {
  if (failure.kind === "mapped") return failure.value;
  return toWireFailure(failure.error);
}

function publicInvocationFields(invocation: NotifiedInvocation<object, unknown>["invocation"]) {
  if (
    typeof invocation === "object" &&
    invocation !== null &&
    "kind" in invocation &&
    (invocation.kind === "action" || invocation.kind === "collection")
  ) {
    return invocationFields(invocation as PublicRequest);
  }
  return {};
}
