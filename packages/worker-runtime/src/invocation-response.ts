import {
  type InternalInvocationFailure,
  type InvocationResult,
} from "@takibi/invocation-lifecycle";
import { jsonResponseFromStatus } from "./envelope/response";
import { emitFailure, requestLogFields, type InternalLogger } from "./logging";
import type { TakibiFailure } from "@takibi/shared-types";
import {
  invocationFields,
  normalizeInvocationFailureForServer,
  wireFailureFromNormalized,
} from "./context/runtime";
import type { TakibiInvocationTypeMap } from "./invocation-type-map";
import type { WireResponse } from "./protocol";

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
    const failure = normalizedFailureFromSettlement(settlement.failure);
    emitFailure(deps.invocationRuntime.logger, failure, {
      ...(invocation.invocation === undefined ? {} : invocationFields(invocation.invocation)),
      ...(deps.localRequest === undefined ? {} : requestLogFields(deps.localRequest)),
    });
    return wireFailureFromNormalized(failure);
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

function normalizedFailureFromSettlement(
  failure: InternalInvocationFailure<TakibiFailure<string>>,
): TakibiFailure<string> {
  if (failure.kind === "mapped") {
    return failure.value;
  }
  return normalizeInvocationFailureForServer(failure.error);
}
