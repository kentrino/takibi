import {
  ForbiddenError,
  NotFoundError,
  TakibiError,
  type ActionGateContext,
  type CollectionDefinition,
  type RuntimeActionDefinition,
} from "@takibi/takibi-api";
import {
  allows,
  denialReasonOf,
  evaluateAccessPolicy,
  isAccessGrant,
  type AccessContext,
  type AccessGrant,
} from "@takibi/takibi-policy";
import { createClass } from "@takibi/takibi-utility";
import type { JsonValue } from "@takibi/takibi-shared-types";
import { assertJsonValue } from "./json";
import type { InternalLogger } from "./logging";
import { otel, type OtelSpec } from "./otel";
import { actionSpanAttributes, collectionSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import { SchemaParser, type SchemaSurface } from "./schema";
import { resolveGateGrant, type ActionInvocation } from "./action-gate";

export type { SchemaSurface } from "./schema";

export type InvocationSpanCtor = {
  readonly logger?: InternalLogger;
  readonly collection?: string;
  readonly operation?: string;
  readonly documentId?: string;
  readonly actionName?: string;
  readonly actionScope?: string;
};

export type PolicySurface = {
  evaluateCollection: (
    def: CollectionDefinition,
    accessCtx: AccessContext<any, any>,
    options: { conceal: boolean; id?: string },
  ) => Promise<AccessGrant>;
  evaluateAction: (
    definition: RuntimeActionDefinition,
    actionCtx: object,
    invocation: ActionInvocation,
    gateContext: ActionGateContext<object>,
    doc?: unknown,
  ) => Promise<AccessGrant>;
};

export type ActionHandlerSurface = {
  run: (args: Record<string, unknown>) => Promise<JsonValue>;
};

export type ActionHandlerCtor = InvocationSpanCtor & {
  readonly definition: RuntimeActionDefinition;
};

export const PolicyEvaluator = createClass<PolicySurface>()
  .constructor<InvocationSpanCtor>({
    runtimeCheck: true,
  })
  .define("evaluateCollection", async (_deps, def, accessCtx, options) => {
    const granted = await evaluateAccessPolicy(def.accessPolicy, accessCtx);
    if (allows(granted, accessCtx.permission)) return granted;
    if (options.conceal) {
      throw new NotFoundError(options.id ? `Document not found: ${options.id}` : "Not found");
    }
    throw new ForbiddenError("Forbidden", denialReasonOf(granted, accessCtx.permission));
  })
  .define("evaluateAction", async (_deps, definition, actionCtx, invocation, gateContext, doc) => {
    const grant = await resolveGateGrant(definition, actionCtx, invocation, gateContext, doc);
    if (!isAccessGrant(grant)) {
      throw new TakibiError("INVALID_POLICY", "Action policy must return an AccessGrant", 500);
    }
    return grant;
  });

export const ActionHandler = createClass<ActionHandlerSurface>()
  .constructor<ActionHandlerCtor>({
    runtimeCheck: true,
  })
  .define("run", async (deps, args) => {
    const output = await deps.definition.handler(args);
    if (output === undefined) return null;
    assertJsonValue(output, {
      subject: "Action output",
      error: (message) => new TakibiError("INVALID_ACTION_OUTPUT", message, 500),
    });
    return output;
  });

const policyOtelSpec: OtelSpec<PolicySurface, InvocationSpanCtor> = {
  evaluateCollection: {
    name: TAKIBI_SPAN.policy,
    kind: "internal" as const,
    event: "takibi.policy" as const,
    attributes: (ctor: InvocationSpanCtor, args: Parameters<PolicySurface["evaluateCollection"]>) =>
      collectionSpanAttributes(
        args[1].collection,
        args[1].operation,
        args[2].id ?? ctor.documentId,
      ),
    logFields: (
      _ctor: InvocationSpanCtor,
      args: Parameters<PolicySurface["evaluateCollection"]>,
    ) => ({
      collection: args[1].collection,
      operation: args[1].operation,
      ...(args[2].id === undefined ? {} : { documentId: args[2].id }),
      ...(args[1].where === undefined ? {} : { query: args[1].where }),
    }),
  },
  evaluateAction: {
    name: TAKIBI_SPAN.policy,
    kind: "internal" as const,
    event: "takibi.policy" as const,
    attributes: (ctor: InvocationSpanCtor) =>
      actionSpanAttributes(ctor.actionName ?? "", ctor.actionScope ?? "$"),
    logFields: (ctor: InvocationSpanCtor) => ({
      ...(ctor.actionScope === undefined || ctor.actionScope === "$"
        ? {}
        : { collection: ctor.actionScope }),
      ...(ctor.actionName === undefined ? {} : { operation: ctor.actionName }),
      ...(ctor.documentId === undefined ? {} : { documentId: ctor.documentId }),
    }),
  },
};

const schemaOtelSpec: OtelSpec<SchemaSurface, InvocationSpanCtor> = {
  parse: {
    name: TAKIBI_SPAN.schema,
    kind: "internal" as const,
    event: "takibi.schema" as const,
  },
};

const actionOtelSpec: OtelSpec<ActionHandlerSurface, ActionHandlerCtor> = {
  run: {
    name: TAKIBI_SPAN.action,
    kind: "internal" as const,
    event: "takibi.action" as const,
    attributes: (ctor: ActionHandlerCtor) =>
      actionSpanAttributes(ctor.actionName ?? "", ctor.actionScope ?? "$"),
    logFields: (ctor: ActionHandlerCtor) => ({
      ...(ctor.actionScope === undefined || ctor.actionScope === "$"
        ? {}
        : { collection: ctor.actionScope }),
      ...(ctor.actionName === undefined ? {} : { operation: ctor.actionName }),
      ...(ctor.documentId === undefined ? {} : { documentId: ctor.documentId }),
    }),
  },
};

export function createInvocationCollaborators(ctor: InvocationSpanCtor) {
  return {
    policy: PolicyEvaluator.newWithInterceptors(ctor, otel(ctor.logger, policyOtelSpec)),
    schema: SchemaParser.newWithInterceptors(ctor, otel(ctor.logger, schemaOtelSpec)),
  };
}

export function createActionHandler(ctor: ActionHandlerCtor) {
  return ActionHandler.newWithInterceptors(ctor, otel(ctor.logger, actionOtelSpec));
}
