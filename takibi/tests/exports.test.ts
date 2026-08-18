import { expect, expectTypeOf, test } from "vite-plus/test";
import { readFileSync } from "node:fs";
import * as Takibi from "../src/index";
import type {
  AccessContext,
  AccessGrant,
  AccessPermission,
  AccessPolicy,
  AccessPolicyFn,
  ClientOf,
  CollectionApi,
  CollectionDefinition,
  CollectionsApi,
  CollectionsDef,
  CollectionsOptions,
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
    AccessPolicy: AccessPolicy<Ctx>;
    AccessPolicyFn: AccessPolicyFn<Ctx>;
    ClientOf: ClientOf<Definitions>;
    CollectionApi: CollectionApi<CollectionDefinition>;
    CollectionDefinition: CollectionDefinition;
    CollectionsApi: CollectionsApi<Definitions>;
    CollectionsDef: CollectionsDef;
    CollectionsOptions: CollectionsOptions;
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
    | "commentCount"
    | "subscribe"
    | "onSnapshot"
    | "enableOffline"
    | "firebase"
    | "AnySchema"
    | "InferSchemaInput"
    | "InferSchemaOutput"
    | "StandardSchemaV1"
    | "ConstrainedPolicy"
    | "ContextPolicy"
    | "InferPolicyDoc"
    | "PolicyHelper"
    | "ReusablePolicy"
    | "ActionGateContext"
    | "ActionGatePolicy"
    | "PublicActionPolicy"
    | "ContextConfig"
    | "ContextResolver"
    | "ContextResolverInput"
    | "ContextStubResolver"
    | "ContextStubResolverInput";
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

test("Standard Schema aliases are not public root types", () => {
  // @ts-expect-error AnySchema must not remain on the public root
  type _AnySchema = import("../src/index").AnySchema;
  // @ts-expect-error InferSchemaInput must not remain on the public root
  type _InferSchemaInput = import("../src/index").InferSchemaInput;
  // @ts-expect-error InferSchemaOutput must not remain on the public root
  type _InferSchemaOutput = import("../src/index").InferSchemaOutput;
  // @ts-expect-error StandardSchemaV1 must not be re-exported from the public root
  type _StandardSchemaV1 = import("../src/index").StandardSchemaV1;
});

test("policy inference implementation types are not public root types", () => {
  // @ts-expect-error ConstrainedPolicy must not remain on the public root
  type _ConstrainedPolicy = import("../src/index").ConstrainedPolicy;
  // @ts-expect-error ContextPolicy must not remain on the public root
  type _ContextPolicy = import("../src/index").ContextPolicy;
  // @ts-expect-error InferPolicyDoc must not remain on the public root
  type _InferPolicyDoc = import("../src/index").InferPolicyDoc;
  // @ts-expect-error PolicyHelper must not remain on the public root
  type _PolicyHelper = import("../src/index").PolicyHelper;
  // @ts-expect-error ReusablePolicy must not be added to the public root
  type _ReusablePolicy = import("../src/index").ReusablePolicy;
});

test("action gate types are not public root types", () => {
  // @ts-expect-error ActionGateContext must not remain on the public root
  type _ActionGateContext = import("../src/index").ActionGateContext;
  // @ts-expect-error ActionGatePolicy must not remain on the public root
  type _ActionGatePolicy = import("../src/index").ActionGatePolicy;
  // @ts-expect-error PublicActionPolicy must not be added to the public root
  type _PublicActionPolicy = import("../src/index").PublicActionPolicy;
});

test("context config split types are not public root types", () => {
  // @ts-expect-error ContextConfig must not remain on the public root
  type _ContextConfig = import("../src/index").ContextConfig;
  // @ts-expect-error ContextResolver must not remain on the public root
  type _ContextResolver = import("../src/index").ContextResolver;
  // @ts-expect-error ContextResolverInput must not remain on the public root
  type _ContextResolverInput = import("../src/index").ContextResolverInput;
  // @ts-expect-error ContextStubResolver must not remain on the public root
  type _ContextStubResolver = import("../src/index").ContextStubResolver;
  // @ts-expect-error ContextStubResolverInput must not remain on the public root
  type _ContextStubResolverInput = import("../src/index").ContextStubResolverInput;
});

test("public category copy names a typed multi-tenant collection store", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    description: string;
  };
  const firstParagraph = readme.split("\n\n")[1] ?? "";
  expect(firstParagraph).toContain("Typed multi-tenant collection store on Cloudflare Durable Objects");
  expect(firstParagraph).not.toContain("Firebase-like");
  expect(pkg.description).toContain("Typed multi-tenant collection store on Cloudflare Durable Objects");
  expect(pkg.description).not.toContain("Firebase-like");
});
