import { expectTypeOf, test } from "vite-plus/test";
import * as Takibi from "../src/index";
import type {
  AccessContext,
  AccessGrant,
  AccessPermission,
  ActionGateContext,
  ClientOf,
  CollectionApi,
  CollectionDefinition,
  CollectionsApi,
  CollectionsDef,
  CollectionsOptions,
  ContextConfig,
  CreateClientOptions,
  TakibiHandler,
  TakibiResult,
  InferCollectionDoc,
  InferHandlerCollections,
  JsonValue,
  ListOptions,
  QueryBuilder,
  QueryExpr,
  QueryOperator,
  QueryScalar,
} from "../src/index";

test("public root exports collection/action entry points", () => {
  expectTypeOf(Takibi.createClient).toBeFunction();
  expectTypeOf(Takibi.createTakibi).toBeFunction();
  expectTypeOf(Takibi.allows).toBeFunction();
  expectTypeOf(Takibi.and).toBeFunction();
  expectTypeOf(Takibi.or).toBeFunction();
  expectTypeOf(Takibi.grant).toBeFunction();
  expectTypeOf(Takibi.queryImpliesEquality).toBeFunction();
  expectTypeOf(Takibi.none).toEqualTypeOf<AccessGrant>();
  expectTypeOf(Takibi.read).toEqualTypeOf<AccessGrant>();
  expectTypeOf(Takibi.write).toEqualTypeOf<AccessGrant>();
  expectTypeOf(Takibi.fullAccess).toEqualTypeOf<AccessGrant>();
});

test("public annotation types use the collection/action vocabulary", () => {
  type Ctx = { tenantId: string; user: unknown };
  type Definitions = { posts: CollectionDefinition };
  type PublicSurface = {
    AccessContext: AccessContext<Ctx>;
    AccessGrant: AccessGrant;
    AccessPermission: AccessPermission;
    ActionGateContext: ActionGateContext<Ctx>;
    ClientOf: ClientOf<Definitions>;
    CollectionApi: CollectionApi<CollectionDefinition>;
    CollectionDefinition: CollectionDefinition;
    CollectionsApi: CollectionsApi<Definitions>;
    CollectionsDef: CollectionsDef;
    CollectionsOptions: CollectionsOptions;
    ContextConfig: ContextConfig<Ctx>;
    CreateClientOptions: CreateClientOptions;
    TakibiHandler: TakibiHandler;
    TakibiResult: TakibiResult<unknown>;
    InferCollectionDoc: InferCollectionDoc<CollectionDefinition>;
    InferHandlerCollections: InferHandlerCollections<TakibiHandler>;
    JsonValue: JsonValue;
    ListOptions: ListOptions;
    QueryBuilder: QueryBuilder<Record<string, string>>;
    QueryExpr: QueryExpr;
    QueryOperator: QueryOperator;
    QueryScalar: QueryScalar;
  };
  expectTypeOf<PublicSurface>().not.toBeNever();
});

test("removed resource/storage aliases and internal assembly APIs are not public", () => {
  expectTypeOf(Takibi).not.toHaveProperty("defineResource");
  expectTypeOf(Takibi).not.toHaveProperty("executeOperation");
  expectTypeOf(Takibi).not.toHaveProperty("createTypedStorage");
  expectTypeOf(Takibi).not.toHaveProperty("parseSchema");
  expectTypeOf(Takibi).not.toHaveProperty("ownedBy");

  type PublicModule = typeof import("../src/index");
  type Removed =
    | "AccessAction"
    | "InferHandlerResources"
    | "InferResourceDoc"
    | "ResourceDefinition"
    | "ResourcesDef"
    | "ResourcesOptions"
    | "defineResource"
    | "executeOperation"
    | "createTypedStorage"
    | "ownedBy"
    | "OwnedByOptions"
    | "FireError"
    | "toFireFailure"
    | "asFireResult"
    | "fire"
    | "initialContext"
    | "sql"
    | "query"
    | "r2"
    | "blob"
    | "forbidArray"
    | "commentCount";
  expectTypeOf<Extract<Removed, keyof PublicModule>>().toBeNever();
});

test("renamed Fire* public names are not exported", () => {
  expectTypeOf(Takibi).not.toHaveProperty("fire");
  expectTypeOf(Takibi).not.toHaveProperty("initialContext");
  expectTypeOf(Takibi).not.toHaveProperty("FireError");
  expectTypeOf(Takibi).not.toHaveProperty("toFireFailure");
  expectTypeOf(Takibi).not.toHaveProperty("asFireResult");

  // @ts-expect-error FireHandler must not remain on the public root
  type _FireHandler = import("../src/index").FireHandler;
  // @ts-expect-error FireResult must not remain on the public root
  type _FireResult = import("../src/index").FireResult;
  // @ts-expect-error FireFailure must not remain on the public root
  type _FireFailure = import("../src/index").FireFailure;
  // @ts-expect-error FireValidationFailure must not remain on the public root
  type _FireValidationFailure = import("../src/index").FireValidationFailure;
  // @ts-expect-error FireOperationFailure must not remain on the public root
  type _FireOperationFailure = import("../src/index").FireOperationFailure;
  // @ts-expect-error FireBrand must not remain on the public root
  type _FireBrand = import("../src/index").FireBrand;
});
