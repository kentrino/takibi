import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TakibiError } from "./errors";
import { isAccessGrant, permissionsOf } from "./policy";
import type { ContextPolicy } from "./policy";
import type {
  AccessGrant,
  AccessPermission,
  CollectionApi,
  CollectionDefinition,
  CollectionsApi,
  JsonValue,
} from "./types";
import { collectionActionsBrand } from "./types";

const actionDefinitionBrand: unique symbol = Symbol("fire.actionDefinition");

export type ActionGateContext<TCtx> = {
  ctx: TCtx;
  scope: { kind: "collection"; name: string } | { kind: "root" };
  invocation: { kind: "action"; name: string };
  permission: AccessPermission;
};

type ActionGatePolicyFn<TCtx> = (
  ctx: ActionGateContext<TCtx>,
) => AccessGrant | Promise<AccessGrant>;

export type ActionGatePolicy<TCtx> = AccessGrant | ContextPolicy<TCtx> | ActionGatePolicyFn<TCtx>;

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

type JsonInputSchema<TSchema extends StandardSchemaV1> =
  unknown extends StandardSchemaV1.InferInput<TSchema>
    ? TSchema
    : Exclude<StandardSchemaV1.InferInput<TSchema>, undefined> extends JsonValue
      ? TSchema
      : never;

type ParsedInput<TSchema extends MaybeSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : undefined;

export type ActionDefinition<
  TKind extends ActionKind = ActionKind,
  TSchema extends MaybeSchema = MaybeSchema,
  TOutput extends JsonValue | void = JsonValue | void,
  TBaseArgs = unknown,
> = {
  readonly [actionDefinitionBrand]: true;
  readonly kind: TKind;
  readonly inputSchema: TSchema;
  readonly permission: AccessPermission;
  readonly policy: ActionGatePolicy<never>;
  readonly handler: (
    args: TBaseArgs & { input: ParsedInput<TSchema> },
  ) => TOutput | Promise<TOutput>;
};

type AuthoredAction = ActionDefinition<ActionKind, MaybeSchema, JsonValue | void, never>;

export type ActionDefinitions = Record<string, AuthoredAction>;

export type RuntimeActionDefinition = {
  readonly kind: ActionKind;
  readonly inputSchema: MaybeSchema;
  readonly permission: AccessPermission;
  readonly policy: ActionGatePolicy<unknown>;
  readonly handler: (args: unknown) => unknown;
};

export type CollectionActionArgs<TCtx, TCollection> = {
  ctx: TCtx;
  collection: CollectionApi<TCollection>;
  $collection: CollectionApi<TCollection>;
};

export type RootActionArgs<TCtx, TCollections> = {
  ctx: TCtx;
  collections: CollectionsApi<TCollections>;
  $collections: CollectionsApi<TCollections>;
};

export type ActionBuilder<
  TCtx,
  TKind extends ActionKind,
  TBaseArgs,
  TSchema extends MaybeSchema = undefined,
> = {
  input<TNextSchema extends StandardSchemaV1>(
    schema: JsonInputSchema<TNextSchema>,
  ): ActionBuilder<TCtx, TKind, TBaseArgs, TNextSchema>;
  requires(permission: AccessPermission): ActionBuilder<TCtx, TKind, TBaseArgs, TSchema>;
  policy: {
    (policy: AccessGrant | ContextPolicy<TCtx>): ActionHandlerBuilder<TKind, TBaseArgs, TSchema>;
    (policy: ActionGatePolicyFn<TCtx>): ActionHandlerBuilder<TKind, TBaseArgs, TSchema>;
  };
};

export type ActionHandlerBuilder<
  TKind extends ActionKind,
  TBaseArgs,
  TSchema extends MaybeSchema,
> = {
  handler<TOutput extends JsonValue | void>(
    handler: (args: TBaseArgs & { input: ParsedInput<TSchema> }) => TOutput | Promise<TOutput>,
  ): ActionDefinition<TKind, TSchema, TOutput, TBaseArgs>;
};

type BuilderState<TKind extends ActionKind, TSchema extends MaybeSchema> = {
  kind: TKind;
  inputSchema: TSchema;
  permission: AccessPermission;
};

export function createActionBuilder<TCtx, TKind extends ActionKind, TBaseArgs>(
  kind: TKind,
): ActionBuilder<TCtx, TKind, TBaseArgs> {
  const createHandlerBuilder = <TSchema extends MaybeSchema>(
    state: BuilderState<TKind, TSchema>,
    policy: AccessGrant | ContextPolicy<TCtx> | ActionGatePolicyFn<TCtx>,
  ): ActionHandlerBuilder<TKind, TBaseArgs, TSchema> => ({
    handler<TOutput extends JsonValue | void>(
      handler: (args: TBaseArgs & { input: ParsedInput<TSchema> }) => TOutput | Promise<TOutput>,
    ): ActionDefinition<TKind, TSchema, TOutput, TBaseArgs> {
      const definition: ActionDefinition<TKind, TSchema, TOutput, TBaseArgs> = {
        [actionDefinitionBrand]: true,
        kind: state.kind,
        inputSchema: state.inputSchema,
        permission: state.permission,
        policy,
        handler,
      };
      return Object.freeze(definition);
    },
  });

  const build = <TSchema extends MaybeSchema>(
    state: BuilderState<TKind, TSchema>,
  ): ActionBuilder<TCtx, TKind, TBaseArgs, TSchema> => ({
    input<TNextSchema extends StandardSchemaV1>(schema: JsonInputSchema<TNextSchema>) {
      return build<TNextSchema>({ ...state, inputSchema: schema });
    },
    requires(permission) {
      return build({ ...state, permission });
    },
    policy(policy) {
      return createHandlerBuilder(state, policy);
    },
  });

  return build({ kind, inputSchema: undefined, permission: "invoke" });
}

export type CollectionDefinitionInput<
  TSchema extends StandardSchemaV1,
  TCtx extends object,
  TActions,
> = {
  schema: CollectionDefinition<TSchema, TCtx>["schema"];
  accessPolicy: CollectionDefinition<TSchema, TCtx>["accessPolicy"];
  migrations?: CollectionDefinition<TSchema, TCtx>["migrations"];
  seed?: CollectionDefinition<TSchema, TCtx>["seed"];
  actions?: (
    defineAction: () => ActionBuilder<
      TCtx,
      "collection",
      CollectionActionArgs<TCtx, CollectionDefinition<TSchema, TCtx>>
    >,
  ) => TActions &
    Record<
      Extract<keyof TActions, CrudName | ReservedPublicName> | InvalidPublicKeys<TActions>,
      never
    >;
};

export function defineCollection<
  TCtx extends object,
  TSchema extends StandardSchemaV1,
  const TActions extends ActionDefinitions = Record<never, never>,
>(
  definition: CollectionDefinitionInput<TSchema, TCtx, TActions>,
): CollectionDefinition<TSchema, TCtx, TActions> & {
  readonly [collectionActionsBrand]: TActions;
} {
  const { actions, ...collection } = definition;
  const actionDefinitions = actions
    ? actions(() =>
        createActionBuilder<
          TCtx,
          "collection",
          CollectionActionArgs<TCtx, CollectionDefinition<TSchema, TCtx>>
        >("collection"),
      )
    : (Object.create(null) as TActions);
  Object.defineProperty(collection, collectionActionsBrand, {
    value: actionDefinitions,
    enumerable: false,
  });
  return collection as CollectionDefinition<TSchema, TCtx, TActions> & {
    readonly [collectionActionsBrand]: TActions;
  };
}

export function getCollectionActions(definition: CollectionDefinition): ActionDefinitions | null {
  if (!(collectionActionsBrand in definition)) return null;
  const actions = definition[collectionActionsBrand];
  return actions === undefined ? null : (actions as unknown as ActionDefinitions);
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
  if (typeof definition.policy !== "function" && !isAccessGrant(definition.policy)) {
    throw new TakibiError("INVALID_ACTION", `Action policy is required: ${name}`, 500);
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
    inputSchema: definition.inputSchema,
    permission: definition.permission,
    policy: definition.policy as RuntimeActionDefinition["policy"],
    handler: definition.handler as RuntimeActionDefinition["handler"],
  };
}

export function assertCollectionName(name: string): void {
  assertPublicName(name, "collection");
  if (name === "$" || name.includes(":")) {
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
    ((value as Partial<ActionDefinition>).kind === "collection" ||
      (value as Partial<ActionDefinition>).kind === "root")
  );
}

function actionKey(scope: string, name: string): string {
  return `${scope}\0${name}`;
}
