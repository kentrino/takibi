import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Takibi from "../src/index";
import * as TakibiClient from "../src/client-entry";
import type {
  AccessContext,
  AccessGrant,
  AccessPermission,
  AccessPolicy,
  AccessPolicyFn,
  ClientOf,
  CollectionApi,
  CollectionsApi,
  CollectionsOptions,
  CreateClientOptions,
  TakibiHandler,
  TakibiResult,
  InferCollectionDoc,
  InferHandlerCollections,
  JsonValue,
  Logger,
  LogEvent,
  LogLevel,
  LoggingOptions,
  PolicyReason,
  PrettyConsoleLoggerOptions,
  QueryBuilder,
  QueryExpr,
  QueryOperator,
  QueryScalar,
} from "../src/index";

const srcDir = join(import.meta.dirname, "../src");
const forbiddenClientModules = [
  "tracing.ts",
  "context/index.ts",
  "schema.ts",
  "executor.ts",
  "storage.ts",
  "logging.ts",
  "instrumentation.ts",
] as const;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectValueSpecifiers(source: string): string[] {
  const body = stripComments(source);
  const specifiers: string[] = [];
  for (const match of body.matchAll(/(?:^|\n)\s*(?:import|export)\s+[\s\S]*?["']([^"']+)["']/g)) {
    const statement = match[0] ?? "";
    const specifier = match[1];
    if (!specifier) continue;
    if (/^\s*(?:import|export)\s+type\b/m.test(statement)) continue;
    specifiers.push(specifier);
  }
  return specifiers;
}

function resolveTsModule(fromFile: string, specifier: string): string {
  if (specifier.endsWith(".ts")) {
    return normalize(join(dirname(fromFile), specifier));
  }
  const asFile = normalize(join(dirname(fromFile), `${specifier}.ts`));
  if (existsSync(asFile)) return asFile;
  return normalize(join(dirname(fromFile), specifier, "index.ts"));
}

function walkValueImports(entryFile: string): Set<string> {
  const visited = new Set<string>();
  const queue = [normalize(entryFile)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    const specifiers = collectValueSpecifiers(readFileSync(file, "utf8"));
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:") || specifier.startsWith("cloudflare:")) {
        visited.add(specifier);
        continue;
      }
      if (!specifier.startsWith(".")) {
        visited.add(specifier);
        continue;
      }
      queue.push(resolveTsModule(file, specifier));
    }
  }
  return visited;
}

test("public root exports collection/action entry points", () => {
  expectTypeOf(Takibi).not.toHaveProperty("createClient");
  expectTypeOf(Takibi.createTakibi).toBeFunction();
  expectTypeOf(Takibi.createPrettyConsoleLogger).toBeFunction();
  expectTypeOf(Takibi).not.toHaveProperty("allows");
  expectTypeOf(Takibi).not.toHaveProperty("GrantCatalog");
  expectTypeOf(Takibi).not.toHaveProperty("GrantBuilder");
  expectTypeOf(Takibi).not.toHaveProperty("grantV2");
  expectTypeOf(Takibi.and).toBeFunction();
  expectTypeOf(Takibi.or).toBeFunction();
  expectTypeOf(Takibi.grant).toBeFunction();
  expectTypeOf(Takibi.queryImpliesEquality).toBeFunction();
  expectTypeOf(Takibi.none).toEqualTypeOf<AccessGrant>();
  expectTypeOf(Takibi.read).toEqualTypeOf<AccessGrant>();
  expectTypeOf(Takibi.write).toEqualTypeOf<AccessGrant>();
  expectTypeOf(Takibi.fullAccess).toEqualTypeOf<AccessGrant>();
  expectTypeOf(Takibi).toHaveProperty("AlreadyExistsError");
  expectTypeOf(Takibi).toHaveProperty("StaleWriteError");
  expectTypeOf<AccessGrant>().not.toHaveProperty("has");
  expectTypeOf<AccessGrant>().not.toHaveProperty("size");
  expectTypeOf<AccessGrant>().not.toMatchTypeOf<ReadonlySet<AccessPermission>>();
  {
    const grantValue: AccessGrant = Takibi.none;
    // @ts-expect-error opaque grant is not a ReadonlySet
    const _set: ReadonlySet<AccessPermission> = grantValue;
    void _set;
  }
});

test("AlreadyExistsError is the ALREADY_EXISTS 409 class", () => {
  const error = new Takibi.AlreadyExistsError();
  expect(error.code).toBe("ALREADY_EXISTS");
  expect(error.status).toBe(409);
  expect(error.message).toBe("Already exists");
  expect(error.name).toBe("AlreadyExistsError");
});

test("StaleWriteError is the STALE_WRITE 409 class", () => {
  const error = new Takibi.StaleWriteError();
  expect(error.code).toBe("STALE_WRITE");
  expect(error.status).toBe(409);
  expect(error.message).toBe("Stale write");
  expect(error.name).toBe("StaleWriteError");
});

test("public annotation types use the collection/action vocabulary", () => {
  type Ctx = { tenantId: string; user: unknown };
  type Collections = InferHandlerCollections<TakibiHandler>;
  type PublicSurface = {
    AccessContext: AccessContext<Ctx>;
    AccessGrant: AccessGrant;
    AccessPermission: AccessPermission;
    AccessPolicy: AccessPolicy<Ctx>;
    AccessPolicyFn: AccessPolicyFn<Ctx>;
    ClientOf: ClientOf<TakibiHandler>;
    CollectionApi: CollectionApi<Collections[string]>;
    CollectionsApi: CollectionsApi<Collections>;
    CollectionsOptions: CollectionsOptions;
    CreateClientOptions: CreateClientOptions;
    TakibiHandler: TakibiHandler;
    TakibiResult: TakibiResult<unknown>;
    InferCollectionDoc: InferCollectionDoc<Collections[string]>;
    InferHandlerCollections: InferHandlerCollections<TakibiHandler>;
    JsonValue: JsonValue;
    Logger: Logger;
    LogEvent: LogEvent;
    LogLevel: LogLevel;
    LoggingOptions: LoggingOptions;
    PolicyReason: PolicyReason<"POLICY_DENIED">;
    PrettyConsoleLoggerOptions: PrettyConsoleLoggerOptions;
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
  expectTypeOf(Takibi).not.toHaveProperty("SchemaValidationError");
  expectTypeOf(Takibi).not.toHaveProperty("validationError");
  expectTypeOf(Takibi).not.toHaveProperty("ConflictError");

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
    | "ContextStubResolverInput"
    | "WithId"
    | "CollectionOperation"
    | "ListOptions"
    | "TakibiFailure"
    | "TakibiValidationFailure"
    | "TakibiOperationFailure"
    | "ValidationIssue"
    | "DocumentId"
    | "DocumentMetadata"
    | "WithMetadata"
    | "SchemaValidationError"
    | "validationError"
    | "BoundPolicyCombinators"
    | "ConflictError"
    | "ClientShape"
    | "ClientFor"
    | "CtxConstraint"
    | "TakibiCtxConstraint"
    | "CollectionDefinition"
    | "CollectionsDef"
    | "defineCollections"
    | "allows"
    | "GrantCatalog"
    | "GrantBuilder"
    | "grantV2"
    | "permissionsOf"
    | "isAccessGrant"
    | "internalTracerKey"
    | "registerGlobalTracer"
    | "registerTracingContextBackend"
    | "TracingContextBackend"
    | "createRecordingTracer"
    | "TakibiTracer"
    | "TakibiSpan"
    | "TakibiInstrumentation"
    | "createOtelTakibiTracer"
    | "failNextStorageWrite";
  expectTypeOf<Extract<Removed, keyof PublicModule>>().toBeNever();

  // @ts-expect-error allows must not remain on the public root
  type _allows = import("../src/index").allows;
  // @ts-expect-error GrantCatalog must not be added to the public root
  type _GrantCatalog = import("../src/index").GrantCatalog;
  // @ts-expect-error GrantBuilder must not be added to the public root
  type _GrantBuilder = import("../src/index").GrantBuilder;
  // @ts-expect-error grantV2 must not be added to the public root
  type _grantV2 = import("../src/index").grantV2;

  // @ts-expect-error ClientShape must not be added to the public root
  type _ClientShape = import("../src/index").ClientShape;
  // @ts-expect-error ClientFor must not be added to the public root
  type _ClientFor = import("../src/index").ClientFor;
  // @ts-expect-error CollectionDefinition must not remain on the public root
  type _CollectionDefinition = import("../src/index").CollectionDefinition;
  // @ts-expect-error CollectionsDef must not remain on the public root
  type _CollectionsDef = import("../src/index").CollectionsDef;
  // @ts-expect-error defineCollections must not be added to the public root
  type _defineCollections = import("../src/index").defineCollections;
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
  // @ts-expect-error CtxConstraint must not be added to the public root
  type _CtxConstraint = import("../src/index").CtxConstraint;
  // @ts-expect-error TakibiCtxConstraint must not be added to the public root
  type _TakibiCtxConstraint = import("../src/index").TakibiCtxConstraint;
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

test("collection internal types are not public root types", () => {
  // @ts-expect-error WithId must not remain on the public root
  type _WithId = import("../src/index").WithId;
  // @ts-expect-error CollectionOperation must not remain on the public root
  type _CollectionOperation = import("../src/index").CollectionOperation;
  // @ts-expect-error ListOptions must not remain on the public root
  type _ListOptions = import("../src/index").ListOptions;
});

test("result leaf types are not public root types", () => {
  // @ts-expect-error TakibiFailure must not remain on the public root
  type _TakibiFailure = import("../src/index").TakibiFailure;
  // @ts-expect-error TakibiValidationFailure must not remain on the public root
  type _TakibiValidationFailure = import("../src/index").TakibiValidationFailure;
  // @ts-expect-error TakibiOperationFailure must not remain on the public root
  type _TakibiOperationFailure = import("../src/index").TakibiOperationFailure;
  // @ts-expect-error ValidationIssue must not remain on the public root
  type _ValidationIssue = import("../src/index").ValidationIssue;
});

test("document metadata helpers are not public root types", () => {
  // @ts-expect-error DocumentId must not remain on the public root
  type _DocumentId = import("../src/index").DocumentId;
  // @ts-expect-error DocumentMetadata must not remain on the public root
  type _DocumentMetadata = import("../src/index").DocumentMetadata;
  // @ts-expect-error WithMetadata must not remain on the public root
  type _WithMetadata = import("../src/index").WithMetadata;
});

test("SchemaValidationError is not a public root type or factory", () => {
  // @ts-expect-error SchemaValidationError must not remain on the public root
  type _SchemaValidationError = import("../src/index").SchemaValidationError;
  // @ts-expect-error validationError must not be added to the public root
  type _validationError = import("../src/index").validationError;
  // @ts-expect-error BoundPolicyCombinators must not be added to the public root
  type _BoundPolicyCombinators = import("../src/index").BoundPolicyCombinators;
  // @ts-expect-error ConflictError must not remain on the public root
  type _ConflictError = import("../src/index").ConflictError;
});

test("public category copy names a typed multi-tenant collection store", () => {
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
    description: string;
  };
  const firstParagraph = readme.split("\n\n")[1] ?? "";
  expect(firstParagraph).toContain(
    "Typed multi-tenant collection store on Cloudflare Durable Objects",
  );
  expect(firstParagraph).not.toContain("Firebase-like");
  expect(pkg.description).toContain(
    "Typed multi-tenant collection store on Cloudflare Durable Objects",
  );
  expect(pkg.description).not.toContain("Firebase-like");
});

test("createClient lives on the browser entry, not the Worker root", () => {
  expectTypeOf(TakibiClient.createClient).toBeFunction();
  expectTypeOf(TakibiClient).not.toHaveProperty("createTakibi");
  expectTypeOf(TakibiClient).not.toHaveProperty("and");
  expectTypeOf(TakibiClient).not.toHaveProperty("or");
  expectTypeOf(TakibiClient).not.toHaveProperty("grant");
  expectTypeOf(TakibiClient).not.toHaveProperty("none");
  expectTypeOf(TakibiClient).not.toHaveProperty("read");
  expectTypeOf(TakibiClient).not.toHaveProperty("write");
  expectTypeOf(TakibiClient).not.toHaveProperty("fullAccess");
  expectTypeOf(TakibiClient).not.toHaveProperty("queryImpliesEquality");
  expectTypeOf(TakibiClient).not.toHaveProperty("createPrettyConsoleLogger");
  // @ts-expect-error logging is server-only
  type _Logger = import("../src/client-entry").Logger;
  expectTypeOf(TakibiClient.TakibiError).toBeConstructibleWith("CODE", "message");
  expectTypeOf(TakibiClient.UnauthorizedError).toBeConstructibleWith();
  expectTypeOf(TakibiClient.ForbiddenError).toBeConstructibleWith();
  expectTypeOf(TakibiClient.NotFoundError).toBeConstructibleWith();
  expectTypeOf(TakibiClient.BadRequestError).toBeConstructibleWith("bad");
  expectTypeOf(TakibiClient.AlreadyExistsError).toBeConstructibleWith();
  expectTypeOf(TakibiClient.StaleWriteError).toBeConstructibleWith();
  expectTypeOf<TakibiClient.ClientOf<TakibiHandler>>().not.toBeNever();
  expectTypeOf<TakibiClient.CreateClientOptions>().toMatchTypeOf<CreateClientOptions>();
  expectTypeOf<TakibiClient.PolicyReason<"POLICY_DENIED">>().toEqualTypeOf<
    PolicyReason<"POLICY_DENIED">
  >();
  expectTypeOf<TakibiClient.TakibiResult<unknown>>().toEqualTypeOf<TakibiResult<unknown>>();

  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  expect(pkg.exports["./client"]).toBe("./src/client-entry.ts");
});

test("the browser entry static import graph stays off Worker modules", () => {
  const files = walkValueImports(join(srcDir, "client-entry.ts"));
  for (const name of forbiddenClientModules) {
    expect(files.has(normalize(join(srcDir, name))), name).toBe(false);
  }
  expect(files.has("node:async_hooks")).toBe(false);
  expect(files.has("cloudflare:workers")).toBe(false);
});

test("the Worker root static import graph stays off Node compatibility modules", () => {
  const files = walkValueImports(join(srcDir, "index.ts"));
  expect([...files].filter((file) => file.startsWith("node:"))).toEqual([]);
  expect([...files].filter((file) => file.startsWith("@opentelemetry/"))).toEqual([]);
});
