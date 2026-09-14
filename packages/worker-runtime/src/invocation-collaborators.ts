import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  ForbiddenError,
  NotFoundError,
  TakibiError,
  type ActionGateContext,
  type CollectionDefinition,
  type RuntimeActionDefinition,
} from "@takibi/api";
import {
  allows,
  denialReasonOf,
  evaluateAccessPolicy,
  isAccessGrant,
  type AccessContext,
  type AccessGrant,
} from "@takibi/policy";
import { assertJsonValue, withTracing } from "@takibi/utility";
import type { JsonValue, WithMetadata } from "@takibi/shared-types";
import { withLoggedSpan } from "./logging";
import type { InternalLogger } from "./logging";
import { actionSpanAttributes, collectionSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import { SchemaParser, traceSchemaParser } from "./schema";
import { resolveGateGrant, type ActionInvocation } from "./action-gate";

export type { SchemaSurface } from "./schema";

export type PolicySurface = {
  evaluateCollection: <S extends StandardSchemaV1, TCtx extends object>(
    def: CollectionDefinition<S, TCtx>,
    accessCtx: AccessContext<NoInfer<TCtx>, WithMetadata<StandardSchemaV1.InferOutput<NoInfer<S>>>>,
    options: { conceal: boolean; id?: string },
  ) => Promise<AccessGrant>;
  evaluateAction: (
    definition: RuntimeActionDefinition,
    actionCtx: unknown,
    invocation: ActionInvocation,
    gateContext: ActionGateContext<unknown>,
    doc?: unknown,
  ) => Promise<AccessGrant>;
};

export type ActionHandlerArgs = {
  ctx: unknown;
  collections: object;
  $collections: object;
  services: unknown;
  input: unknown;
  collection?: object;
  $collection?: object;
  id?: string;
  doc?: unknown;
};

export type ActionHandlerSurface = {
  run: (args: ActionHandlerArgs) => Promise<JsonValue>;
};

export type ActionHandlerCtor = {
  readonly definition: RuntimeActionDefinition;
  readonly logger?: InternalLogger;
  readonly collection?: string;
  readonly operation?: string;
  readonly documentId?: string;
  readonly actionName?: string;
  readonly actionScope?: string;
};

export type InvocationSpanCtor = {
  readonly logger?: InternalLogger;
};

export class PolicyEvaluator implements PolicySurface {
  async evaluateCollection<S extends StandardSchemaV1, TCtx extends object>(
    def: CollectionDefinition<S, TCtx>,
    accessCtx: AccessContext<NoInfer<TCtx>, WithMetadata<StandardSchemaV1.InferOutput<NoInfer<S>>>>,
    options: { conceal: boolean; id?: string },
  ): Promise<AccessGrant> {
    const granted = await evaluateAccessPolicy(def.accessPolicy, accessCtx);
    if (allows(granted, accessCtx.permission)) return granted;
    if (options.conceal) {
      throw new NotFoundError(options.id ? `Document not found: ${options.id}` : "Not found");
    }
    throw new ForbiddenError("Forbidden", denialReasonOf(granted, accessCtx.permission));
  }

  async evaluateAction(
    definition: RuntimeActionDefinition,
    actionCtx: unknown,
    invocation: ActionInvocation,
    gateContext: ActionGateContext<unknown>,
    doc?: unknown,
  ): Promise<AccessGrant> {
    const grant = await resolveGateGrant(definition, actionCtx, invocation, gateContext, doc);
    if (!isAccessGrant(grant)) {
      throw new TakibiError("INVALID_POLICY", "Action policy must return an AccessGrant", 500);
    }
    return grant;
  }
}

export class ActionHandler implements ActionHandlerSurface {
  readonly #definition: RuntimeActionDefinition;

  constructor(deps: { definition: RuntimeActionDefinition }) {
    this.#definition = deps.definition;
  }

  async run(args: ActionHandlerArgs): Promise<JsonValue> {
    const output = await this.#definition.handler(args);
    if (output === undefined) return null;
    assertJsonValue(output, {
      subject: "Action output",
      error: (message) => new TakibiError("INVALID_ACTION_OUTPUT", message, 500),
    });
    return output;
  }
}

export function tracePolicyEvaluator(
  policy: PolicyEvaluator,
  logger: InternalLogger | undefined,
): PolicySurface {
  const withCollection = withTracing(policy, {
    method: "evaluateCollection",
    span: TAKIBI_SPAN.policy,
    kind: "internal",
    attributes: (_def, accessCtx, options) =>
      collectionSpanAttributes(accessCtx.collection, accessCtx.operation, options.id),
    run: (spec, fn, args) => {
      const accessCtx = args[1];
      const options = args[2];
      return withLoggedSpan(
        logger,
        spec,
        {
          event: "takibi.policy",
          collection: accessCtx.collection,
          operation: accessCtx.operation,
          ...(options.id === undefined ? {} : { documentId: options.id }),
          ...(accessCtx.where === undefined ? {} : { query: accessCtx.where }),
        },
        fn,
      );
    },
  });
  return withTracing(withCollection, {
    method: "evaluateAction",
    span: TAKIBI_SPAN.policy,
    kind: "internal",
    attributes: (_definition, _actionCtx, invocation) =>
      actionSpanAttributes(invocation.name, invocation.scope),
    run: (spec, fn, args) => {
      const invocation = args[2];
      return withLoggedSpan(
        logger,
        spec,
        {
          event: "takibi.policy",
          ...(invocation.scope === "$" ? {} : { collection: invocation.scope }),
          operation: invocation.name,
          ...(invocation.id === undefined ? {} : { documentId: invocation.id }),
        },
        fn,
      );
    },
  });
}

export function traceActionHandler(
  handler: ActionHandler,
  ctor: ActionHandlerCtor,
): ActionHandlerSurface {
  return withTracing(handler, {
    method: "run",
    span: TAKIBI_SPAN.action,
    kind: "internal",
    attributes: () => actionSpanAttributes(ctor.actionName ?? "", ctor.actionScope ?? "$"),
    run: (spec, fn) =>
      withLoggedSpan(
        ctor.logger,
        spec,
        {
          event: "takibi.action",
          ...(ctor.actionScope === undefined || ctor.actionScope === "$"
            ? {}
            : { collection: ctor.actionScope }),
          ...(ctor.actionName === undefined ? {} : { operation: ctor.actionName }),
          ...(ctor.documentId === undefined ? {} : { documentId: ctor.documentId }),
        },
        fn,
      ),
  });
}

export function createInvocationCollaborators(ctor: InvocationSpanCtor) {
  return {
    policy: tracePolicyEvaluator(new PolicyEvaluator(), ctor.logger),
    schema: traceSchemaParser(new SchemaParser(), ctor.logger),
  };
}

export function createActionHandler(ctor: ActionHandlerCtor) {
  return traceActionHandler(new ActionHandler({ definition: ctor.definition }), ctor);
}
