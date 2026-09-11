import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ClientCollectionApi, TakibiDefinitionCarrier } from "@takibi/api";
import type { PolicyReasonCodeOf } from "@takibi/policy";
import type { TakibiResult } from "@takibi/shared-types";

export type { TakibiDefinitionCarrier };

export type InferHandlerCollections<H> = H extends {
  readonly "~takibi": { collections: infer C };
}
  ? C
  : never;

/** Scope map registered via `app.actions({ ... })` (`$` plus collection keys). */
export type InferHandlerActions<H> = H extends {
  readonly "~takibi": { actions: infer A };
}
  ? A
  : Record<never, never>;

type ScopeActionsOf<TMap, K extends string> = K extends keyof TMap ? TMap[K] : Record<never, never>;

type ActionSchema<TAction> = TAction extends {
  readonly inputSchema: infer TSchema;
}
  ? TSchema
  : never;

type ActionInput<TAction> =
  ActionSchema<TAction> extends infer TSchema
    ? TSchema extends StandardSchemaV1
      ? StandardSchemaV1.InferInput<TSchema>
      : never
    : never;

type NormalizeActionOutput<T> = T extends void ? null : T;

type ActionOutput<TAction> = TAction extends {
  readonly handler: (...args: infer _TArgs) => infer TResult;
}
  ? NormalizeActionOutput<Awaited<TResult>>
  : never;

type ActionReasonCode<TAction> = TAction extends { readonly policy: infer TPolicy }
  ? PolicyReasonCodeOf<TPolicy>
  : never;

type DetachedActionClientMethod<TAction> = TAction extends {
  readonly inputSchema: infer TSchema;
}
  ? TSchema extends StandardSchemaV1
    ? undefined extends ActionInput<TAction>
      ? (
          input?: ActionInput<TAction>,
        ) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
      : (
          input: ActionInput<TAction>,
        ) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
    : () => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
  : never;

type DocumentActionClientMethod<TAction> = TAction extends {
  readonly inputSchema: infer TSchema;
}
  ? TSchema extends StandardSchemaV1
    ? undefined extends ActionInput<TAction>
      ? (
          id: string,
          input?: ActionInput<TAction>,
        ) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
      : (
          id: string,
          input: ActionInput<TAction>,
        ) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
    : (id: string) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
  : never;

type ActionClientMethod<TAction> = TAction extends { readonly target: "document" }
  ? DocumentActionClientMethod<TAction>
  : DetachedActionClientMethod<TAction>;

type ActionsClient<TActions> = {
  [K in keyof TActions as K extends string ? K : never]: ActionClientMethod<TActions[K]>;
};

type ClientFromMaps<TCollections, TActionMap = Record<never, never>> = {
  [K in keyof TCollections]: ClientCollectionApi<TCollections[K]> &
    (K extends string ? ActionsClient<ScopeActionsOf<TActionMap, K>> : Record<never, never>);
} & ActionsClient<ScopeActionsOf<TActionMap, "$">>;

export type ClientOf<H extends TakibiDefinitionCarrier> = H extends infer Concrete
  ? ClientFromMaps<InferHandlerCollections<Concrete>, InferHandlerActions<Concrete>>
  : never;
