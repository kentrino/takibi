import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TakibiError } from "./errors";
import { isAccessGrant, isConstrainedPolicy, permissionsOf } from "./policy";
import type { ConstrainedPolicy, ContextPolicy } from "./policy";
import type {
  AccessContext,
  AccessGrant,
  AccessPermission,
  CollectionApi,
  CollectionDefinition,
  CollectionIndexes,
  CollectionUniqueConstraints,
  CollectionsApi,
  InferCollectionDoc,
  IndexDeclaration,
  JsonValue,
  UniqueConstraintDeclaration,
} from "./types";

const actionDefinitionBrand: unique symbol = Symbol("fire.actionDefinition");

/** Type-only brand carried by `app.<collection>.actions(cb)` return maps. */
declare const scopedActionsBrand: unique symbol;

export type ScopedActions<TScope extends string, TActions> = TActions & {
  readonly [scopedActionsBrand]: TScope;
};

export type ActionTarget = "document" | "detached";

export type ActionGateContext<TCtx, TDoc = unknown> = {
  ctx: TCtx;
  scope: { kind: "collection"; name: string } | { kind: "root" };
  invocation: { kind: "action"; name: string };
  permission: AccessPermission;
  /** Present only when a document action is gated. */
  target?: { id: string; doc: TDoc };
};

export type DocumentGateContext<TCtx, TDoc> = ActionGateContext<TCtx, TDoc> & {
  target: { id: string; doc: TDoc };
};

type DetachedGatePolicyFn<TCtx> = (
  ctx: ActionGateContext<TCtx, never>,
) => AccessGrant | Promise<AccessGrant>;

type DocumentGatePolicyFn<TCtx, TDoc> = (
  ctx: DocumentGateContext<TCtx, TDoc>,
) => AccessGrant | Promise<AccessGrant>;

/**
 * Schema-bound gate for document actions. Two ConstrainedPolicy signatures
 * compare as bare generic functions and always unify, so the pick-key check
 * would silently pass; intersecting with the instantiated policy function
 * forces the pick-keys conditional to resolve against this collection's
 * document type.
 */
type DocumentConstrainedGate<TCtx extends object, TDoc> = ConstrainedPolicy<TCtx, TDoc> &
  ((ctx: AccessContext<TCtx, TDoc>) => AccessGrant | Promise<AccessGrant>);

export type ActionGatePolicy<TCtx, TDoc = never> =
  | AccessGrant
  | ContextPolicy<TCtx>
  | ConstrainedPolicy<TCtx extends object ? TCtx : object, TDoc>
  | DocumentGatePolicyFn<TCtx, TDoc>
  | DetachedGatePolicyFn<TCtx>;

type ActionKind = "collection" | "root";
type MaybeSchema = StandardSchemaV1 | undefined;
export type ReservedPublicName =
  | "then"
  | "catch"
  | "finally"
  | "toJSON"
  | "toString"
  | "valueOf"
  | "__proto__"
  | "prototype"
  | "constructor"
  | "bind"
  | "call"
  | "apply"
  | "name"
  | "length"
  | "caller"
  | "arguments";
type CrudName = "add" | "set" | "get" | "list" | "update" | "delete";
type LowercaseLetter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";
type IdentifierStart = LowercaseLetter | Uppercase<LowercaseLetter> | "_";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type IdentifierRest = IdentifierStart | Digit;
type HasValidIdentifierRest<TName extends string> = TName extends ""
  ? true
  : TName extends `${IdentifierRest}${infer TRest}`
    ? HasValidIdentifierRest<TRest>
    : false;
type IsValidIdentifier<TName extends string> = string extends TName
  ? true
  : TName extends `${IdentifierStart}${infer TRest}`
    ? HasValidIdentifierRest<TRest>
    : false;
export type InvalidPublicKeys<TMap> = {
  [K in keyof TMap]: K extends string ? (IsValidIdentifier<K> extends true ? never : K) : K;
}[keyof TMap];

export type ActionNameConstraint<TActions> = Record<
  Extract<keyof TActions, CrudName | ReservedPublicName> | InvalidPublicKeys<TActions>,
  never
>;

type IsAny<T> = 0 extends 1 & T ? true : false;

type JsonInputSchema<TSchema extends StandardSchemaV1> =
  unknown extends StandardSchemaV1.InferInput<TSchema>
    ? TSchema
    : Exclude<StandardSchemaV1.InferInput<TSchema>, undefined> extends JsonValue
      ? TSchema
      : never;

/**
 * Detached collection actions must not accept bare-string input: the client
 * routes a single string argument as a document id, so a string input would
 * be indistinguishable from a document target on the wire.
 */
type DetachedInputSchema<TSchema extends StandardSchemaV1> =
  IsAny<StandardSchemaV1.InferInput<TSchema>> extends true
    ? never
    : unknown extends StandardSchemaV1.InferInput<TSchema>
      ? never
      : Extract<StandardSchemaV1.InferInput<TSchema>, string> extends never
        ? JsonInputSchema<TSchema>
        : never;

type ParsedInput<TSchema extends MaybeSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : undefined;

/** Middleware that refines action context before the gate and handler run. */
export type ActionGuard<TCtx, TNext> = (ctx: TCtx) => TNext | Promise<TNext>;

export type ActionGuardFn = (ctx: unknown) => unknown;

/** Replace `ctx` on handler / gate args after a `use` guard. */
type WithRefinedCtx<TArgs, TCtx> = Omit<TArgs, "ctx"> & { ctx: TCtx };

export type ActionDefinition<
  TKind extends ActionKind = ActionKind,
  TSchema extends MaybeSchema = MaybeSchema,
  TOutput extends JsonValue | void = JsonValue | void,
  TBaseArgs = unknown,
  TTarget extends ActionTarget = ActionTarget,
  TPolicy = ActionGatePolicy<never, never>,
> = {
  readonly [actionDefinitionBrand]: true;
  readonly kind: TKind;
  readonly target: TTarget;
  /** Registration scope this definition was created for (collection name or `$`). */
  readonly scope: string;
  readonly inputSchema: TSchema;
  readonly permission: AccessPermission;
  readonly atomic: boolean;
  readonly guards: readonly ActionGuardFn[];
  readonly policy: TPolicy;
  readonly handler: (
    args: TBaseArgs & { input: ParsedInput<TSchema> },
  ) => TOutput | Promise<TOutput>;
};

type AuthoredAction = ActionDefinition<ActionKind, MaybeSchema, JsonValue | void, never>;

export type ActionDefinitions = Record<string, AuthoredAction>;

export type RuntimeActionDefinition = {
  readonly kind: ActionKind;
  readonly target: ActionTarget;
  readonly inputSchema: MaybeSchema;
  readonly permission: AccessPermission;
  readonly atomic: boolean;
  readonly guards: readonly ActionGuardFn[];
  readonly policy: ActionGatePolicy<unknown, unknown>;
  readonly handler: (args: unknown) => unknown;
};

export type RootActionArgs<TCtx, TCollections, TServices = Record<never, never>> = {
  ctx: TCtx;
  collections: CollectionsApi<TCollections>;
  $collections: CollectionsApi<TCollections>;
  services: TServices;
};

export type CollectionActionArgs<
  TCtx,
  TCollections,
  TCollection,
  TServices = Record<never, never>,
> = RootActionArgs<TCtx, TCollections, TServices> & {
  collection: CollectionApi<TCollection>;
  $collection: CollectionApi<TCollection>;
};

export type DocumentActionArgs<
  TCtx,
  TCollections,
  TCollection,
  TServices = Record<never, never>,
> = CollectionActionArgs<TCtx, TCollections, TCollection, TServices> & {
  id: string;
  doc: InferCollectionDoc<TCollection>;
};

export type ActionHandlerBuilder<
  TKind extends ActionKind,
  TBaseArgs,
  TSchema extends MaybeSchema,
  TTarget extends ActionTarget = "detached",
  TPolicy = ActionGatePolicy<never, never>,
> = {
  handler<TOutput extends JsonValue | void>(
    handler: (args: TBaseArgs & { input: ParsedInput<TSchema> }) => TOutput | Promise<TOutput>,
  ): ActionDefinition<TKind, TSchema, TOutput, TBaseArgs, TTarget, TPolicy>;
  atomic(): ActionHandlerBuilder<TKind, TBaseArgs, TSchema, TTarget, TPolicy>;
};

/**
 * Collection action builder. Starts as a document action (the handler
 * receives `{ id, doc }` and the gate sees the target document); call
 * `.detached()` before `.input()` / `.policy()` for actions that are not
 * bound to one existing document (creation, aggregation, no-target pings).
 *
 * `.use(fn)` may only appear immediately after `defineAction()` (or another
 * `.use()`); it refines the context type for the gate and handler.
 */
export type DocumentActionBuilder<
  TCtx,
  TDocArgs,
  TDetachedArgs,
  TDoc,
  TSchema extends MaybeSchema = undefined,
> = {
  use<TNext>(
    fn: ActionGuard<TCtx, TNext>,
  ): DocumentActionBuilder<
    TNext,
    WithRefinedCtx<TDocArgs, TNext>,
    WithRefinedCtx<TDetachedArgs, TNext>,
    TDoc,
    TSchema
  >;
  input<TNextSchema extends StandardSchemaV1>(
    schema: JsonInputSchema<TNextSchema>,
  ): Omit<
    DocumentActionBuilder<TCtx, TDocArgs, TDetachedArgs, TDoc, TNextSchema>,
    "detached" | "use"
  >;
  requires(
    permission: AccessPermission,
  ): Omit<DocumentActionBuilder<TCtx, TDocArgs, TDetachedArgs, TDoc, TSchema>, "use">;
  atomic(): Omit<DocumentActionBuilder<TCtx, TDocArgs, TDetachedArgs, TDoc, TSchema>, "use">;
  detached(): DetachedActionBuilder<TCtx, TDetachedArgs, TSchema>;
  policy: {
    <const TPolicy extends AccessGrant | ContextPolicy<TCtx>>(
      policy: TPolicy,
    ): ActionHandlerBuilder<"collection", TDocArgs, TSchema, "document", TPolicy>;
    // Inline gate callbacks must be tried before ConstrainedPolicy: that type
    // is an unbranded generic function, so it would contextually swallow bare
    // arrows and hide `target` from them.
    <const TPolicy extends DocumentGatePolicyFn<TCtx, TDoc>>(
      policy: TPolicy,
    ): ActionHandlerBuilder<"collection", TDocArgs, TSchema, "document", TPolicy>;
    <const TPolicy extends DocumentConstrainedGate<TCtx extends object ? TCtx : object, TDoc>>(
      policy: TPolicy,
    ): ActionHandlerBuilder<"collection", TDocArgs, TSchema, "document", TPolicy>;
  };
};

export type DetachedActionBuilder<TCtx, TBaseArgs, TSchema extends MaybeSchema = undefined> = {
  input<TNextSchema extends StandardSchemaV1>(
    schema: DetachedInputSchema<TNextSchema>,
  ): DetachedActionBuilder<TCtx, TBaseArgs, TNextSchema>;
  requires(permission: AccessPermission): DetachedActionBuilder<TCtx, TBaseArgs, TSchema>;
  atomic(): DetachedActionBuilder<TCtx, TBaseArgs, TSchema>;
  policy: {
    <const TPolicy extends AccessGrant | ContextPolicy<TCtx>>(
      policy: TPolicy,
    ): ActionHandlerBuilder<"collection", TBaseArgs, TSchema, "detached", TPolicy>;
    <const TPolicy extends DetachedGatePolicyFn<TCtx>>(
      policy: TPolicy,
    ): ActionHandlerBuilder<"collection", TBaseArgs, TSchema, "detached", TPolicy>;
  };
};

export type RootActionBuilder<TCtx, TBaseArgs, TSchema extends MaybeSchema = undefined> = {
  use<TNext>(
    fn: ActionGuard<TCtx, TNext>,
  ): RootActionBuilder<TNext, WithRefinedCtx<TBaseArgs, TNext>, TSchema>;
  input<TNextSchema extends StandardSchemaV1>(
    schema: JsonInputSchema<TNextSchema>,
  ): Omit<RootActionBuilder<TCtx, TBaseArgs, TNextSchema>, "use">;
  requires(permission: AccessPermission): Omit<RootActionBuilder<TCtx, TBaseArgs, TSchema>, "use">;
  atomic(): Omit<RootActionBuilder<TCtx, TBaseArgs, TSchema>, "use">;
  policy: {
    <const TPolicy extends AccessGrant | ContextPolicy<TCtx>>(
      policy: TPolicy,
    ): ActionHandlerBuilder<"root", TBaseArgs, TSchema, "detached", TPolicy>;
    <const TPolicy extends DetachedGatePolicyFn<TCtx>>(
      policy: TPolicy,
    ): ActionHandlerBuilder<"root", TBaseArgs, TSchema, "detached", TPolicy>;
  };
};

type BuilderState = {
  kind: ActionKind;
  target: ActionTarget;
  scope: string;
  inputSchema: MaybeSchema;
  permission: AccessPermission;
  atomic: boolean;
  guards: ActionGuardFn[];
};

function createHandlerBuilder(
  state: BuilderState,
  policy: ActionGatePolicy<unknown, unknown>,
): ActionHandlerBuilder<
  ActionKind,
  unknown,
  MaybeSchema,
  ActionTarget,
  ActionGatePolicy<unknown, unknown>
> {
  return {
    atomic() {
      return createHandlerBuilder({ ...state, atomic: true }, policy);
    },
    handler(handler) {
      const definition = {
        [actionDefinitionBrand]: true as const,
        kind: state.kind,
        target: state.target,
        scope: state.scope,
        inputSchema: state.inputSchema,
        permission: state.permission,
        atomic: state.atomic,
        guards: Object.freeze([...state.guards]),
        policy: policy as ActionGatePolicy<never, never>,
        handler,
      };
      return Object.freeze(definition) as never;
    },
  } as ActionHandlerBuilder<
    ActionKind,
    unknown,
    MaybeSchema,
    ActionTarget,
    ActionGatePolicy<unknown, unknown>
  >;
}

function createBuilder(state: BuilderState): Record<string, unknown> {
  return {
    use(fn: ActionGuardFn) {
      return createBuilder({ ...state, guards: [...state.guards, fn] });
    },
    input(schema: StandardSchemaV1) {
      return createBuilder({ ...state, inputSchema: schema });
    },
    requires(permission: AccessPermission) {
      return createBuilder({ ...state, permission });
    },
    atomic() {
      return createBuilder({ ...state, atomic: true });
    },
    detached() {
      return createBuilder({ ...state, target: "detached" });
    },
    policy(policy: ActionGatePolicy<unknown, unknown>) {
      return createHandlerBuilder(state, policy);
    },
  };
}

export function createDocumentActionBuilder<TCtx, TDocArgs, TDetachedArgs, TDoc>(
  collection: string,
): DocumentActionBuilder<TCtx, TDocArgs, TDetachedArgs, TDoc> {
  return createBuilder({
    kind: "collection",
    target: "document",
    scope: collection,
    inputSchema: undefined,
    permission: "invoke",
    atomic: false,
    guards: [],
  }) as unknown as DocumentActionBuilder<TCtx, TDocArgs, TDetachedArgs, TDoc>;
}

export function createRootActionBuilder<TCtx, TBaseArgs>(): RootActionBuilder<TCtx, TBaseArgs> {
  return createBuilder({
    kind: "root",
    target: "detached",
    scope: "$",
    inputSchema: undefined,
    permission: "invoke",
    atomic: false,
    guards: [],
  }) as unknown as RootActionBuilder<TCtx, TBaseArgs>;
}

export type CollectionDefinitionInput<
  TSchema extends StandardSchemaV1,
  TCtx extends object,
  TPolicy extends CollectionDefinition<TSchema, TCtx>["accessPolicy"] = CollectionDefinition<
    TSchema,
    TCtx
  >["accessPolicy"],
  TUnique extends CollectionUniqueConstraints<TSchema> = CollectionUniqueConstraints<TSchema>,
  TIndexes extends CollectionIndexes<TSchema> | Record<string, never> = Record<string, never>,
> = {
  schema: CollectionDefinition<TSchema, TCtx>["schema"];
  accessPolicy: TPolicy;
  unique?: TUnique & UniqueConstraintDeclaration<TSchema, TUnique>;
  indexes?: TIndexes & IndexDeclaration<TSchema, TIndexes>;
  migrations?: CollectionDefinition<TSchema, TCtx>["migrations"];
  seed?: CollectionDefinition<TSchema, TCtx>["seed"];
};

export function defineCollection<
  TCtx extends object,
  TSchema extends StandardSchemaV1,
  const TPolicy extends CollectionDefinition<TSchema, TCtx>["accessPolicy"],
  const TUnique extends CollectionUniqueConstraints<TSchema> = CollectionUniqueConstraints<TSchema>,
  const TIndexes extends CollectionIndexes<TSchema> | Record<string, never> = Record<string, never>,
>(
  definition: CollectionDefinitionInput<TSchema, TCtx, TPolicy, TUnique, TIndexes>,
): CollectionDefinition<TSchema, TCtx, TPolicy, TIndexes> {
  assertNoActionsOption(definition);
  return definition as CollectionDefinition<TSchema, TCtx, TPolicy, TIndexes>;
}

export function assertNoActionsOption(definition: object): void {
  if ("actions" in definition) {
    throw new TakibiError(
      "INVALID_COLLECTION",
      "Collection definitions no longer take actions — define them via app.<collection>.actions()",
      500,
    );
  }
}

export type RegisteredAction = {
  scope: string;
  name: string;
  definition: RuntimeActionDefinition;
};

const CRUD_NAMES = new Set(["add", "set", "get", "list", "update", "delete"]);
const REFLECTION_NAMES = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "toString",
  "valueOf",
  "__proto__",
  "prototype",
  "constructor",
  "bind",
  "call",
  "apply",
  "name",
  "length",
  "caller",
  "arguments",
]);
/** App definition members that collection names must not shadow. */
const APP_DEFINITION_NAMES = new Set(["defineAction", "actions"]);
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const unsafeClientPropertyNames: ReadonlySet<string> = REFLECTION_NAMES;

export class ActionRegistry {
  readonly #actions = new Map<string, RegisteredAction>();

  get(scope: string, name: string): RegisteredAction | undefined {
    return this.#actions.get(actionKey(scope, name));
  }

  registerCollectionActions(collection: string, definitions: ActionDefinitions): void {
    this.#register(collection, definitions, "collection", new Set(CRUD_NAMES));
  }

  registerRootActions(definitions: ActionDefinitions, collectionNames: ReadonlySet<string>): void {
    this.#register("$", definitions, "root", collectionNames);
  }

  clone(): ActionRegistry {
    const copy = new ActionRegistry();
    for (const [key, entry] of this.#actions) {
      copy.#actions.set(key, entry);
    }
    return copy;
  }

  #register(
    scope: string,
    definitions: ActionDefinitions,
    expectedKind: ActionKind,
    forbiddenNames: ReadonlySet<string>,
  ): void {
    if (typeof definitions !== "object" || definitions === null) {
      throw new TakibiError("INVALID_ACTION", "Action definitions must be an object", 500);
    }
    const prototype = Object.getPrototypeOf(definitions);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TakibiError("INVALID_ACTION", "Action definitions must be a plain object", 500);
    }
    const pending: RegisteredAction[] = [];
    for (const propertyKey of Reflect.ownKeys(definitions)) {
      if (typeof propertyKey !== "string") {
        throw new TakibiError("INVALID_ACTION", "Action names must be strings", 500);
      }
      const descriptor = Object.getOwnPropertyDescriptor(definitions, propertyKey);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TakibiError(
          "INVALID_ACTION",
          `Action definitions must be enumerable data properties: ${propertyKey}`,
          500,
        );
      }
      const name = propertyKey;
      const definition: unknown = descriptor.value;
      assertPublicName(name, "action");
      if (forbiddenNames.has(name)) {
        throw new TakibiError(
          "RESERVED_ACTION",
          `Action name conflicts with a reserved name: ${name}`,
          500,
        );
      }
      if (!isActionDefinition(definition) || definition.kind !== expectedKind) {
        throw new TakibiError(
          "INVALID_ACTION",
          `Invalid ${expectedKind} action definition: ${name}`,
          500,
        );
      }
      if (definition.scope !== scope) {
        throw new TakibiError(
          "INVALID_ACTION",
          `Action was defined for scope "${definition.scope}" but registered under "${scope}": ${name}`,
          500,
        );
      }
      const runtimeDefinition = eraseForRegistry(name, definition);
      const registryKey = actionKey(scope, name);
      if (
        this.#actions.has(registryKey) ||
        pending.some((entry) => actionKey(entry.scope, entry.name) === registryKey)
      ) {
        throw new TakibiError("DUPLICATE_ACTION", `Action is already registered: ${name}`, 500);
      }
      pending.push({ scope, name, definition: runtimeDefinition });
    }

    for (const entry of pending) {
      this.#actions.set(actionKey(entry.scope, entry.name), entry);
    }
  }
}

const ACCESS_PERMISSIONS = new Set<AccessPermission>([
  "create",
  "get",
  "list",
  "update",
  "delete",
  "invoke",
]);

function assertActionContract(name: string, definition: AuthoredAction): void {
  if (!ACCESS_PERMISSIONS.has(definition.permission)) {
    throw new TakibiError("INVALID_ACTION", `Invalid action permission: ${name}`, 500);
  }
  if (definition.target !== "document" && definition.target !== "detached") {
    throw new TakibiError("INVALID_ACTION", `Invalid action target: ${name}`, 500);
  }
  if (typeof definition.atomic !== "boolean") {
    throw new TakibiError("INVALID_ACTION", `Invalid action atomic flag: ${name}`, 500);
  }
  if (
    !Array.isArray(definition.guards) ||
    definition.guards.some((guard) => typeof guard !== "function")
  ) {
    throw new TakibiError("INVALID_ACTION", `Invalid action guards: ${name}`, 500);
  }
  if (typeof definition.policy !== "function" && !isAccessGrant(definition.policy)) {
    throw new TakibiError("INVALID_ACTION", `Action policy is required: ${name}`, 500);
  }
  if (definition.target === "detached" && isConstrainedPolicy(definition.policy)) {
    throw new TakibiError(
      "INVALID_ACTION",
      `Schema-bound policies require a document action gate: ${name}`,
      500,
    );
  }
  if (isAccessGrant(definition.policy)) {
    for (const permission of permissionsOf(definition.policy)) {
      if (!ACCESS_PERMISSIONS.has(permission)) {
        throw new TakibiError("INVALID_ACTION", `Invalid action policy grant: ${name}`, 500);
      }
    }
  }
  if (
    definition.inputSchema !== undefined &&
    (typeof definition.inputSchema !== "object" ||
      definition.inputSchema === null ||
      typeof definition.inputSchema["~standard"]?.validate !== "function")
  ) {
    throw new TakibiError("INVALID_ACTION", `Invalid action input schema: ${name}`, 500);
  }
}

function eraseForRegistry(name: string, definition: AuthoredAction): RuntimeActionDefinition {
  assertActionContract(name, definition);
  return {
    kind: definition.kind,
    target: definition.target,
    inputSchema: definition.inputSchema,
    permission: definition.permission,
    atomic: definition.atomic,
    guards: definition.guards,
    policy: definition.policy as RuntimeActionDefinition["policy"],
    handler: definition.handler as RuntimeActionDefinition["handler"],
  };
}

export function assertCollectionName(name: string): void {
  assertPublicName(name, "collection");
  if (name === "$" || name.includes(":") || APP_DEFINITION_NAMES.has(name)) {
    throw new TakibiError("RESERVED_COLLECTION", `Invalid collection name: ${name}`, 500);
  }
}

function assertPublicName(name: string, kind: "collection" | "action"): void {
  if (!NAME_PATTERN.test(name) || REFLECTION_NAMES.has(name)) {
    throw new TakibiError(
      kind === "collection" ? "INVALID_COLLECTION" : "INVALID_ACTION",
      `Invalid ${kind} name: ${name}`,
      500,
    );
  }
}

function isActionDefinition(value: unknown): value is AuthoredAction {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<ActionDefinition>)[actionDefinitionBrand] === true &&
    typeof (value as Partial<ActionDefinition>).handler === "function" &&
    typeof (value as Partial<ActionDefinition>).scope === "string" &&
    ((value as Partial<ActionDefinition>).kind === "collection" ||
      (value as Partial<ActionDefinition>).kind === "root")
  );
}

function actionKey(scope: string, name: string): string {
  return `${scope}\0${name}`;
}
