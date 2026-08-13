import { expectTypeOf, test } from "vite-plus/test";
import * as Fire from "../src/index";
import type {
  AccessAction,
  AccessContext,
  AccessGrant,
  AccessPolicy,
  AccessPolicyFn,
  AnySchema,
  ClientOf,
  CollectionApi,
  ConstrainedPolicy,
  ContextConfig,
  ContextResolver,
  ContextResolverInput,
  ContextStubResolver,
  ContextStubResolverInput,
  CreateClientOptions,
  DocumentId,
  DocumentMetadata,
  FireFailure,
  FireHandler,
  FireOperationFailure,
  FireResult,
  FireValidationFailure,
  HandleOptions,
  HandleResult,
  InferHandlerResources,
  InferPolicyDoc,
  InferResourceDoc,
  InferResourceInput,
  InferSchemaInput,
  InferSchemaOutput,
  ListOptions,
  OwnedByOptions,
  PolicyHelper,
  ResourceDataInput,
  ResourceDefinition,
  ResourcesDef,
  ResourcesOptions,
  ValidationIssue,
  WithId,
  WithMetadata,
} from "../src/index";

test("public root exports documented entry points", () => {
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
  expectTypeOf(Fire.ownedBy).toBeFunction();
  expectTypeOf(Fire.defineResource).toBeFunction();
  expectTypeOf(Fire.FireError).toBeConstructibleWith("CODE", "message");
  expectTypeOf(Fire.UnauthorizedError).toBeConstructibleWith();
  expectTypeOf(Fire.ForbiddenError).toBeConstructibleWith();
  expectTypeOf(Fire.NotFoundError).toBeConstructibleWith();
  expectTypeOf(Fire.BadRequestError).toBeConstructibleWith("message");
  expectTypeOf(Fire.ConflictError).toBeConstructibleWith();
  expectTypeOf(Fire.SchemaValidationError).toBeConstructibleWith([]);
});

test("annotation types stay on the public root", () => {
  type Ctx = { tenantId: string; user: unknown };
  type PublicSurface = {
    CreateClientOptions: CreateClientOptions;
    InferHandlerResources: InferHandlerResources<FireHandler>;
    ClientOf: ClientOf<Record<string, never>>;
    CollectionApi: CollectionApi<{ schema: AnySchema }>;
    FireHandler: FireHandler;
    HandleOptions: HandleOptions<Record<string, never>>;
    HandleResult: HandleResult;
    ResourcesOptions: ResourcesOptions;
    ContextConfig: ContextConfig<Ctx>;
    ContextResolver: ContextResolver<Ctx>;
    ContextResolverInput: ContextResolverInput;
    ContextStubResolver: ContextStubResolver<Ctx>;
    ContextStubResolverInput: ContextStubResolverInput<Ctx>;
    AccessAction: AccessAction;
    AccessContext: AccessContext<Ctx>;
    AccessGrant: AccessGrant;
    AccessPolicy: AccessPolicy<Ctx>;
    AccessPolicyFn: AccessPolicyFn<Ctx>;
    ConstrainedPolicy: ConstrainedPolicy<Ctx, { title: string }>;
    InferPolicyDoc: InferPolicyDoc<AnySchema>;
    PolicyHelper: PolicyHelper<Ctx>;
    OwnedByOptions: OwnedByOptions<Ctx>;
    ResourceDefinition: ResourceDefinition;
    ResourcesDef: ResourcesDef;
    InferResourceDoc: InferResourceDoc<{ schema: AnySchema }>;
    InferResourceInput: InferResourceInput<{ schema: AnySchema }>;
    ResourceDataInput: ResourceDataInput<{ schema: AnySchema }>;
    DocumentId: DocumentId;
    DocumentMetadata: DocumentMetadata;
    WithId: WithId<{ id: string }>;
    WithMetadata: WithMetadata<{ id: string }>;
    ListOptions: ListOptions;
    FireResult: FireResult<unknown>;
    FireFailure: FireFailure;
    FireOperationFailure: FireOperationFailure;
    FireValidationFailure: FireValidationFailure;
    ValidationIssue: ValidationIssue;
    AnySchema: AnySchema;
    InferSchemaInput: InferSchemaInput<AnySchema>;
    InferSchemaOutput: InferSchemaOutput<AnySchema>;
  };
  expectTypeOf<PublicSurface>().not.toBeNever();
});

test("internal assembly APIs are not on the public root", () => {
  expectTypeOf(Fire).not.toHaveProperty("executeOperation");
  expectTypeOf(Fire).not.toHaveProperty("createTypedStorage");
  expectTypeOf(Fire).not.toHaveProperty("createMemoryStorage");
  expectTypeOf(Fire).not.toHaveProperty("createDurableObjectStorage");
  expectTypeOf(Fire).not.toHaveProperty("parseSchema");

  type PublicModule = typeof import("../src/index");
  type ForbiddenValues =
    | "executeOperation"
    | "createTypedStorage"
    | "createMemoryStorage"
    | "createDurableObjectStorage"
    | "parseSchema";
  expectTypeOf<Extract<ForbiddenValues, keyof PublicModule>>().toBeNever();

  // @ts-expect-error StorageDriver is not a public export
  type UnpublishedStorageDriver = import("../src/index").StorageDriver;
  // @ts-expect-error ResourceOperation is not a public export
  type UnpublishedResourceOperation = import("../src/index").ResourceOperation;
  expectTypeOf<[UnpublishedStorageDriver, UnpublishedResourceOperation]>().not.toBeNever();
});
