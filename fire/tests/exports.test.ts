import { expectTypeOf, test } from "vite-plus/test";
import * as Fire from "../src/index";
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
  FireHandler,
  FireResult,
  InferCollectionDoc,
  InferHandlerCollections,
  JsonValue,
} from "../src/index";

test("public root exports collection/action entry points", () => {
  expectTypeOf(Fire.createClient).toBeFunction();
  expectTypeOf(Fire.fire).toHaveProperty("initialContext");
  expectTypeOf(Fire.initialContext).toBeFunction();
  expectTypeOf(Fire.allows).toBeFunction();
  expectTypeOf(Fire.and).toBeFunction();
  expectTypeOf(Fire.or).toBeFunction();
  expectTypeOf(Fire.grant).toBeFunction();
  expectTypeOf(Fire.none).toEqualTypeOf<AccessGrant>();
  expectTypeOf(Fire.read).toEqualTypeOf<AccessGrant>();
  expectTypeOf(Fire.write).toEqualTypeOf<AccessGrant>();
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
    FireHandler: FireHandler;
    FireResult: FireResult<unknown>;
    InferCollectionDoc: InferCollectionDoc<CollectionDefinition>;
    InferHandlerCollections: InferHandlerCollections<FireHandler>;
    JsonValue: JsonValue;
  };
  expectTypeOf<PublicSurface>().not.toBeNever();
});

test("removed resource/storage aliases and internal assembly APIs are not public", () => {
  expectTypeOf(Fire).not.toHaveProperty("defineResource");
  expectTypeOf(Fire).not.toHaveProperty("executeOperation");
  expectTypeOf(Fire).not.toHaveProperty("createTypedStorage");
  expectTypeOf(Fire).not.toHaveProperty("parseSchema");
  expectTypeOf(Fire).not.toHaveProperty("ownedBy");

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
    | "OwnedByOptions";
  expectTypeOf<Extract<Removed, keyof PublicModule>>().toBeNever();
});
