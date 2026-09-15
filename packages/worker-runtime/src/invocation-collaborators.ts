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
import { ListScopeError } from "@takibi/query";
import { assertJsonValue } from "@takibi/utility";
import type { JsonValue, WithMetadata } from "@takibi/shared-types";
import type { InternalLogger } from "./logging";
import { actionSpanAttributes, collectionSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import { SchemaParser } from "./schema";
import { resolveGateGrant, type ActionInvocation } from "./action-gate";
import { traced } from "./traced";

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
    let granted: AccessGrant;
    try {
      granted = await evaluateAccessPolicy(def.accessPolicy, accessCtx);
      if (!isAccessGrant(granted))
        throw new TakibiError("INVALID_POLICY", "Policy must return an AccessGrant", 500);
    } catch (error) {
      if (error instanceof ListScopeError)
        throw new TakibiError("INVALID_LIST_SCOPE", "Invalid list authorization scope", 500);
      throw error;
    }
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

export function createPolicyEvaluator(logger: InternalLogger | undefined): PolicySurface {
  return traced(new PolicyEvaluator(), logger, {
    evaluateCollection: {
      name: TAKIBI_SPAN.policy,
      kind: "internal",
      event: "takibi.policy",
      attributes: ([_def, accessCtx, options]) =>
        collectionSpanAttributes(accessCtx.collection, accessCtx.operation, options.id),
      logFields: ([_def, accessCtx, options]) => ({
        collection: accessCtx.collection,
        operation: accessCtx.operation,
        ...(options.id === undefined ? {} : { documentId: options.id }),
        ...(accessCtx.where === undefined ? {} : { query: accessCtx.where }),
      }),
    },
    evaluateAction: {
      name: TAKIBI_SPAN.policy,
      kind: "internal",
      event: "takibi.policy",
      attributes: ([_definition, _actionCtx, invocation]) =>
        actionSpanAttributes(invocation.name, invocation.scope),
      logFields: ([_definition, _actionCtx, invocation]) => ({
        ...(invocation.scope === "$" ? {} : { collection: invocation.scope }),
        operation: invocation.name,
        ...(invocation.id === undefined ? {} : { documentId: invocation.id }),
      }),
    },
  });
}

export function createInvocationCollaborators(ctor: InvocationSpanCtor) {
  return {
    policy: createPolicyEvaluator(ctor.logger),
    schema: traced(new SchemaParser(), ctor.logger, {
      parse: {
        name: TAKIBI_SPAN.schema,
        kind: "internal",
        event: "takibi.schema",
      },
    }),
  };
}

export function createActionHandler(ctor: ActionHandlerCtor): ActionHandlerSurface {
  return traced(new ActionHandler({ definition: ctor.definition }), ctor.logger, {
    run: {
      name: TAKIBI_SPAN.action,
      kind: "internal",
      event: "takibi.action",
      attributes: () => actionSpanAttributes(ctor.actionName ?? "", ctor.actionScope ?? "$"),
      logFields: () => ({
        ...(ctor.actionScope === undefined || ctor.actionScope === "$"
          ? {}
          : { collection: ctor.actionScope }),
        ...(ctor.actionName === undefined ? {} : { operation: ctor.actionName }),
        ...(ctor.documentId === undefined ? {} : { documentId: ctor.documentId }),
      }),
    },
  });
}
