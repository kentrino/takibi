import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import {
  createDocumentActionBuilder,
  createRootActionBuilder,
  defineCollection,
  type ClientCollectionApi,
  type ClientOf,
  type CollectionApi,
  type CollectionDataInput,
  type DurableObjectCollectionsApi,
  type InferCollectionDoc,
  type InferCollectionInput,
  type JsonValue,
  type SnapshotRestoreReport,
  type TakibiDefinition,
  type TrustedCollectionApi,
  type TrustedCollectionsApi,
} from "../src";
import {
  and,
  createPolicyHelper,
  fullAccess,
  grant,
  type ConstrainedPolicy,
} from "@takibi/takibi-policy";

type AppCtx = { tenantId: string; user: { id: string } | null };

test("collection schemas infer input, output, and reserved-key-free writes", () => {
  const posts = defineCollection({
    schema: z.object({ title: z.string(), published: z.boolean().default(false) }),
    accessPolicy: fullAccess,
  });

  expectTypeOf<CollectionDataInput<typeof posts>>().toEqualTypeOf<{
    title: string;
    published?: boolean;
  }>();
  expectTypeOf<InferCollectionInput<typeof posts>>().toHaveProperty("title");
  expectTypeOf<InferCollectionDoc<typeof posts>>().toMatchTypeOf<{
    id: string;
    title: string;
    published: boolean;
    createdAt: string;
    updatedAt: string;
    rev: number;
  }>();
  expectTypeOf<InferCollectionDoc<typeof posts>>().not.toHaveProperty("$schemaVersion");
  expectTypeOf<CollectionDataInput<typeof posts>>().not.toHaveProperty("id");
  expectTypeOf<CollectionDataInput<typeof posts>>().not.toHaveProperty("rev");
});

test("collection schemas require plain JSON object outputs and reject reserved keys", () => {
  defineCollection({
    schema: z.object({
      nested: z.object({ label: z.string() }),
      values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
    accessPolicy: fullAccess,
  });

  const checkInvalidSchemas = () => {
    defineCollection({
      // @ts-expect-error collection output must be an object
      schema: z.string(),
      accessPolicy: fullAccess,
    });
    defineCollection({
      // @ts-expect-error collection output must be an object, not an array
      schema: z.array(z.string()),
      accessPolicy: fullAccess,
    });
    defineCollection({
      // @ts-expect-error Date is not a JSON value
      schema: z.object({ created: z.date() }),
      accessPolicy: fullAccess,
    });
    defineCollection({
      // @ts-expect-error bigint is not a JSON value
      schema: z.object({ count: z.bigint() }),
      accessPolicy: fullAccess,
    });
    defineCollection({
      // @ts-expect-error a present undefined value is not a JSON value
      schema: z.object({ missing: z.undefined() }),
      accessPolicy: fullAccess,
    });
    defineCollection({
      // @ts-expect-error server-managed metadata cannot be a schema field
      schema: z.object({ id: z.string() }),
      accessPolicy: fullAccess,
    });
    defineCollection({
      // @ts-expect-error server-managed metadata cannot be a schema field
      schema: z.object({ createdAt: z.string() }),
      accessPolicy: fullAccess,
    });
    defineCollection({
      // @ts-expect-error server-managed metadata cannot be a schema field
      schema: z.object({ updatedAt: z.string() }),
      accessPolicy: fullAccess,
    });
    defineCollection({
      // @ts-expect-error schema version is reserved
      schema: z.object({ $schemaVersion: z.number() }),
      accessPolicy: fullAccess,
    });
    defineCollection({
      // @ts-expect-error revision is reserved
      schema: z.object({ rev: z.number() }),
      accessPolicy: fullAccess,
    });
  };
  void checkInvalidSchemas;
});

test("optional unique fields remain eligible after excluding null", () => {
  const schema = z.object({
    slug: z.string(),
    ownerId: z.string(),
    externalId: z.string().nullable().optional(),
    nested: z.object({ value: z.string() }),
    labels: z.array(z.string()),
  });

  defineCollection({
    schema,
    accessPolicy: fullAccess,
    unique: {
      bySlug: ["slug"],
      byOwnerExternalId: ["ownerId", "externalId"],
    },
  });

  const checkInvalidConstraints = () => {
    defineCollection({
      schema,
      accessPolicy: fullAccess,
      unique: {
        // @ts-expect-error unique tuples must not be empty
        empty: [],
      },
    });
    defineCollection({
      schema,
      accessPolicy: fullAccess,
      unique: {
        // @ts-expect-error unique fields must be top-level scalars
        nested: ["nested"],
        // @ts-expect-error arrays are not unique scalar fields
        labels: ["labels"],
        // @ts-expect-error unknown fields cannot be constrained
        missing: ["missing"],
      },
    });
    defineCollection({
      schema,
      accessPolicy: fullAccess,
      unique: {
        // @ts-expect-error a field cannot occur twice in one constraint
        duplicate: ["slug", "slug"],
      },
    });
  };
  void checkInvalidConstraints;
});

test("collection indexes accept required scalar tuples and reject invalid declarations", () => {
  const schema = z.object({
    ownerId: z.string(),
    status: z.string(),
    published: z.boolean(),
    optionalTitle: z.string().optional(),
    nullableNote: z.string().nullable(),
    nested: z.object({ value: z.string() }),
    labels: z.array(z.string()),
  });

  defineCollection({
    schema,
    accessPolicy: fullAccess,
    indexes: {
      byOwner: ["ownerId", "createdAt"],
      byStatus: ["status", "updatedAt"],
    },
  });

  const checkInvalidIndexes = () => {
    defineCollection({
      schema,
      accessPolicy: fullAccess,
      indexes: {
        // @ts-expect-error index tuples must not be empty
        empty: [],
      },
    });
    defineCollection({
      schema,
      accessPolicy: fullAccess,
      indexes: {
        // @ts-expect-error optional fields cannot be indexed
        optional: ["optionalTitle"],
        // @ts-expect-error nullable fields cannot be indexed
        nullable: ["nullableNote"],
        // @ts-expect-error boolean fields cannot be indexed
        published: ["published"],
        // @ts-expect-error nested fields cannot be indexed
        nested: ["nested"],
        // @ts-expect-error arrays cannot be indexed
        labels: ["labels"],
      },
    });
    defineCollection({
      schema,
      accessPolicy: fullAccess,
      indexes: {
        // @ts-expect-error a field cannot occur twice in one index
        duplicate: ["ownerId", "ownerId"],
      },
    });
  };
  void checkInvalidIndexes;
});

test("collection, trusted, client, and snapshot-capable API types stay distinct", () => {
  const posts = defineCollection({
    schema: z.object({ title: z.string(), published: z.boolean() }),
    accessPolicy: fullAccess,
  });
  type Collections = { posts: typeof posts };

  expectTypeOf<CollectionApi<typeof posts>>().toHaveProperty("count");
  expectTypeOf<CollectionApi<typeof posts>>().not.toHaveProperty("updateMany");
  expectTypeOf<TrustedCollectionApi<typeof posts>>().toHaveProperty("updateMany");
  expectTypeOf<TrustedCollectionApi<typeof posts>>().toHaveProperty("incrementOne");
  expectTypeOf<ClientCollectionApi<typeof posts>>().not.toHaveProperty("count");
  expectTypeOf<ClientCollectionApi<typeof posts>>().not.toHaveProperty("updateMany");
  expectTypeOf<TrustedCollectionsApi<Collections>>().toHaveProperty("$transaction");
  expectTypeOf<TrustedCollectionsApi<Collections>>().not.toHaveProperty("$exportSnapshot");
  expectTypeOf<DurableObjectCollectionsApi<Collections>>().toHaveProperty("$exportSnapshot");
  expectTypeOf<DurableObjectCollectionsApi<Collections>>().toHaveProperty("$restoreSnapshot");
  expectTypeOf<DurableObjectCollectionsApi<Collections>>().toHaveProperty("$resetAll");
  expectTypeOf<
    Awaited<ReturnType<DurableObjectCollectionsApi<Collections>["$restoreSnapshot"]>>
  >().toEqualTypeOf<SnapshotRestoreReport>();
});

test("document, detached, and root action builders infer distinct targets and inputs", () => {
  const document = createDocumentActionBuilder<
    AppCtx,
    { id: string; doc: { title: string } },
    { collection: unknown },
    { title: string }
  >("posts");
  const transformed = document
    .input(z.string().transform((value) => value.length))
    .policy(fullAccess)
    .handler(({ input, id, doc }) => {
      expectTypeOf(input).toEqualTypeOf<number>();
      expectTypeOf(id).toEqualTypeOf<string>();
      expectTypeOf(doc.title).toEqualTypeOf<string>();
      return { length: input };
    });
  const optional = document
    .input(z.object({ label: z.string() }).optional())
    .policy(fullAccess)
    .handler(({ input }) => ({ value: input?.label ?? null }));
  const noInput = document.policy(fullAccess).handler(({ input }) => {
    expectTypeOf(input).toEqualTypeOf<undefined>();
    return { ok: true as const };
  });
  const detached = document
    .detached()
    .input(z.object({ limit: z.number() }))
    .policy(fullAccess)
    .handler((args) => {
      expectTypeOf(args.input).toEqualTypeOf<{ limit: number }>();
      expectTypeOf(args).not.toHaveProperty("id");
      expectTypeOf(args).not.toHaveProperty("doc");
      return { count: args.input.limit };
    });
  const root = createRootActionBuilder<AppCtx, { collections: unknown }>()
    .policy(fullAccess)
    .handler(({ input }) => {
      expectTypeOf(input).toEqualTypeOf<undefined>();
      return { count: 0 };
    });

  expectTypeOf(transformed.target).toEqualTypeOf<"document">();
  expectTypeOf(optional.target).toEqualTypeOf<"document">();
  expectTypeOf(noInput.target).toEqualTypeOf<"document">();
  expectTypeOf(detached.target).toEqualTypeOf<"detached">();
  expectTypeOf(root.target).toEqualTypeOf<"detached">();
  expectTypeOf(root.kind).toEqualTypeOf<"root">();
  expectTypeOf(createRootActionBuilder()).not.toHaveProperty("detached");

  const checkOrdering = () => {
    document
      .input(z.object({ title: z.string() }))
      // @ts-expect-error detached() must be called before input()
      .detached();
    document
      .input(z.object({ title: z.string() }))
      // @ts-expect-error use() must be called immediately after defineAction()
      .use((ctx: AppCtx) => ctx);
    // @ts-expect-error handler is unavailable until policy is set
    document.handler(() => null);
    document
      .detached()
      // @ts-expect-error detached collection actions cannot accept bare-string input
      .input(z.string());
    document
      .detached()
      // @ts-expect-error detached collection actions cannot accept string unions either
      .input(z.union([z.string(), z.object({ ok: z.boolean() })]));
    createRootActionBuilder()
      // @ts-expect-error action inputs must be JSON-safe before schema parsing
      .input(z.date());
  };
  void checkOrdering;
});

test("action output and policy reason-code inference reach ClientOf on a structural carrier", () => {
  const inputSchema = z.string().transform((value) => value.length);
  type StructuralHandler = TakibiDefinition<
    { readonly posts: { readonly schema: z.ZodObject<{ title: z.ZodString }> } },
    {
      readonly $: {
        readonly inspect: {
          readonly inputSchema: typeof inputSchema;
          readonly handler: (args: { input: number }) => Promise<{ positive: boolean }>;
        };
      };
      readonly posts: {
        readonly touch: {
          readonly target: "document";
          readonly inputSchema: undefined;
          readonly handler: (args: { id: string }) => Promise<{ touched: true }>;
        };
      };
    }
  >;

  type StructuralClient = ClientOf<StructuralHandler>;
  expectTypeOf<StructuralClient["inspect"]>().toEqualTypeOf<
    (
      input: string,
    ) => Promise<import("@takibi/takibi-shared-types").TakibiResult<{ positive: boolean }>>
  >();
  expectTypeOf<StructuralClient["posts"]["touch"]>().toEqualTypeOf<
    (
      id: string,
    ) => Promise<import("@takibi/takibi-shared-types").TakibiResult<{ touched: true }>>
  >();
});

test("collection and action definitions accept direct takibi-policy grants", () => {
  const helper = createPolicyHelper<AppCtx>();
  const posts = defineCollection({
    schema: z.object({ title: z.string(), ownerId: z.string() }),
    accessPolicy: and(fullAccess, grant("list")),
  });
  const action = createDocumentActionBuilder<
    AppCtx,
    { id: string; doc: { title: string } },
    object,
    { title: string }
  >("posts")
    .policy(grant("invoke"))
    .handler(({ id }) => ({ id }));

  expectTypeOf(posts.accessPolicy).toEqualTypeOf(and(fullAccess, grant("list")));
  expectTypeOf(action.policy).toEqualTypeOf(grant("invoke"));
  const bound: ConstrainedPolicy<AppCtx, { ownerId: string }> = helper(
    z.object({ ownerId: z.string() }),
    () => fullAccess,
  );
  createDocumentActionBuilder<
    AppCtx,
    { id: string; doc: { title: string; ownerId: string } },
    object,
    { title: string; ownerId: string }
  >("posts")
    .policy(bound)
    .handler(() => null);

  const checkDetachedBound = () => {
    createDocumentActionBuilder("posts")
      .detached()
      // @ts-expect-error schema-bound policies are excluded from detached gates
      .policy(bound);
    createRootActionBuilder()
      // @ts-expect-error schema-bound policies are excluded from root gates
      .policy(bound);
  };
  void checkDetachedBound;
});

test("JsonValue includes arrays", () => {
  expectTypeOf<string[]>().toExtend<JsonValue>();
  expectTypeOf<JsonValue[]>().toExtend<JsonValue>();
});
