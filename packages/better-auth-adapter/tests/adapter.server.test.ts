import { betterAuth } from "better-auth";
import { admin, bearer } from "better-auth/plugins";
import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { takibiAdapter, type BetterAuthModelMap } from "@takibi/better-auth-adapter";
import { createTestCollection } from "./test-collection.server";

type Row = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

type State = {
  tables: Record<string, Map<string, Row>>;
};

type HarnessCollection = ReturnType<typeof createTestCollection>;
type HarnessTransaction = <R>(
  callback: (collections: HarnessCollections) => Promise<R>,
) => Promise<R>;
type HarnessCollections = {
  [name: string]: HarnessCollection | HarnessTransaction;
  $transaction: HarnessTransaction;
};

const schemas = {
  user: z.object({
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    banned: z.boolean().nullable().optional(),
    banReason: z.string().nullable().optional(),
    banExpires: z.iso.datetime().nullable().optional(),
  }),
  session: z.object({
    expiresAt: z.iso.datetime(),
    token: z.string(),
    ipAddress: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
    userId: z.string(),
    impersonatedBy: z.string().nullable().optional(),
  }),
  account: z.object({
    accountId: z.string(),
    providerId: z.string(),
    userId: z.string(),
    accessToken: z.string().nullable().optional(),
    refreshToken: z.string().nullable().optional(),
    idToken: z.string().nullable().optional(),
    accessTokenExpiresAt: z.iso.datetime().nullable().optional(),
    refreshTokenExpiresAt: z.iso.datetime().nullable().optional(),
    scope: z.string().nullable().optional(),
    password: z.string().nullable().optional(),
  }),
  verification: z.object({
    identifier: z.string(),
    value: z.string(),
    expiresAt: z.iso.datetime(),
    attempts: z.number().nullable().optional(),
  }),
} as const;

const collectionNames = {
  user: "authUsers",
  session: "authSessions",
  account: "authAccounts",
  verification: "authVerifications",
} as const;

const MODELS = {
  user: {
    collection: collectionNames.user,
    schema: schemas.user,
    indexes: { byEmail: ["email"] },
  },
  session: {
    collection: collectionNames.session,
    schema: schemas.session,
    indexes: { byToken: ["token"], byUser: ["userId", "createdAt"] },
  },
  account: {
    collection: collectionNames.account,
    schema: schemas.account,
    indexes: {
      byProviderAccount: ["providerId", "accountId"],
      byUser: ["userId", "createdAt"],
    },
  },
  verification: {
    collection: collectionNames.verification,
    schema: schemas.verification,
    indexes: {
      byIdentifierValue: ["identifier", "value"],
      byExpiry: ["expiresAt", "createdAt"],
    },
  },
} as const;

function createHarness(
  models: BetterAuthModelMap<(typeof collectionNames)[keyof typeof collectionNames]> = MODELS,
) {
  const scanEvents: unknown[] = [];
  const listCalls: Array<{ collection: string; operation: string; options: unknown }> = [];
  const state: State = {
    tables: Object.fromEntries(Object.values(collectionNames).map((name) => [name, new Map()])),
  };

  const collectionsFor = (active: State, transactionBound = false): HarnessCollections => {
    const collections: HarnessCollections = {
      ...Object.fromEntries(
        Object.keys(active.tables).map((name) => [
          name,
          createTestCollection(
            () => active.tables[name]!,
            (operation, options) => listCalls.push({ collection: name, operation, options }),
          ),
        ]),
      ),
      async $transaction<R>(callback: (scoped: HarnessCollections) => Promise<R>): Promise<R> {
        if (transactionBound) return callback(collections);
        const snapshot: State = {
          tables: Object.fromEntries(
            Object.entries(active.tables).map(([name, rows]) => [
              name,
              new Map([...rows].map(([id, row]) => [id, structuredClone(row)])),
            ]),
          ),
        };
        const result = await callback(collectionsFor(snapshot, true));
        active.tables = snapshot.tables;
        return result;
      },
    };
    return collections;
  };

  const collections = collectionsFor(state);
  const database = takibiAdapter({
    collections,
    models,
    onFallbackScan: (event) => scanEvents.push(event),
  });
  const adapter = database({
    emailAndPassword: { enabled: true },
    experimental: { joins: true },
    plugins: [admin()],
    verification: {
      additionalFields: {
        attempts: { type: "number", required: false },
      },
    },
  });
  return { adapter, database, state, scanEvents, listCalls };
}

test("rejects a caller schema that drops a Better Auth field", async () => {
  const incompatibleModels = {
    ...MODELS,
    user: {
      collection: collectionNames.user,
      schema: z.object({
        name: z.string(),
        emailVerified: z.boolean(),
        image: z.string().nullable().optional(),
      }),
    },
  };
  const { adapter } = createHarness(incompatibleModels);

  await expect(
    adapter.findMany({
      model: "user",
      limit: 1,
    }),
  ).rejects.toThrow('Takibi schema for Better Auth model "user" does not retain field "email"');
});

test.each([
  ["requires", z.string()],
  ["rejects null for", z.string().optional()],
] as const)(
  "rejects a caller schema that %s an optional Better Auth field",
  async (_description, image) => {
    const incompatibleModels = {
      ...MODELS,
      user: {
        collection: collectionNames.user,
        schema: z.object({
          name: z.string(),
          email: z.string(),
          emailVerified: z.boolean(),
          image,
          role: z.string().nullable().optional(),
          banned: z.boolean().nullable().optional(),
          banReason: z.string().nullable().optional(),
          banExpires: z.iso.datetime().nullable().optional(),
        }),
      },
    };
    const { adapter } = createHarness(incompatibleModels);

    await expect(
      adapter.findMany({
        model: "user",
        limit: 1,
      }),
    ).rejects.toThrow(
      /Takibi schema for Better Auth model "user" rejected its optional\/null field/,
    );
  },
);

async function createUser(
  adapter: ReturnType<typeof createHarness>["adapter"],
  id: string,
  email: string,
) {
  return adapter.create<Record<string, unknown>, Record<string, unknown>>({
    model: "user",
    data: {
      id,
      name: id,
      email,
      emailVerified: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    forceAllowId: true,
  });
}

test("core CRUD transforms Takibi metadata and Better Auth dates", async () => {
  const { adapter, listCalls, scanEvents } = createHarness();
  const created = await createUser(adapter, "u1", "One@Example.com");

  expect(created).toMatchObject({
    id: "u1",
    name: "u1",
    email: "One@Example.com",
    emailVerified: false,
  });
  expect(created.createdAt).toBeInstanceOf(Date);
  expect(created).not.toHaveProperty("rev");

  await expect(
    adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [
        {
          field: "email",
          value: "one@example.com",
          operator: "eq",
          mode: "insensitive",
        },
      ],
    }),
  ).resolves.toMatchObject({ id: "u1" });
  expect(scanEvents).toContainEqual({
    model: "user",
    operation: "findOne",
    operators: ["eq"],
    scannedCount: 1,
  });
  expect(JSON.stringify(scanEvents)).not.toContain("one@example.com");

  await adapter.findOne({
    model: "user",
    where: [{ field: "email", value: "One@Example.com" }],
  });
  expect(listCalls.at(-1)).toMatchObject({
    collection: "authUsers",
    options: {
      index: "byEmail",
      where: expect.any(Function),
    },
  });

  await expect(
    adapter.update<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", value: "u1" }],
      update: { name: "Updated" },
    }),
  ).resolves.toMatchObject({ id: "u1", name: "Updated" });

  await adapter.delete({
    model: "user",
    where: [{ field: "id", value: "u1" }],
  });
  await expect(
    adapter.findOne({
      model: "user",
      where: [{ field: "id", value: "u1" }],
    }),
  ).resolves.toBeNull();
});

test("projection, generated ids, and database null semantics match Better Auth", async () => {
  const { adapter, database } = createHarness();
  const databaseGeneratedIdAdapter = database({
    emailAndPassword: { enabled: true },
    advanced: { database: { generateId: false } },
  });
  const generated = await databaseGeneratedIdAdapter.create<Record<string, unknown>>({
    model: "user",
    data: {
      name: "Generated",
      email: "generated@example.com",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    forceAllowId: true,
  });
  expect(generated.id).toEqual(expect.any(String));

  const projected = await adapter.findMany<Record<string, unknown>>({
    model: "user",
    where: [{ field: "image", value: null }],
    limit: 10,
    select: ["id", "email"],
  });
  expect(projected).toEqual([
    {
      id: generated.id,
      email: "generated@example.com",
    },
  ]);
  await expect(
    adapter.findMany<Record<string, unknown>>({
      model: "user",
      limit: 10,
      select: [],
    }),
  ).resolves.toEqual([
    expect.objectContaining({
      id: generated.id,
      email: "generated@example.com",
      name: "Generated",
    }),
  ]);
  await expect(
    adapter.count({
      model: "user",
      where: [{ field: "image", operator: "ne", value: null }],
    }),
  ).resolves.toBe(0);
});

test("transactions retain the options of the adapter instance that created them", async () => {
  const { database } = createHarness();
  const first = database({
    emailAndPassword: { enabled: true },
    plugins: [admin()],
  });
  database({ emailAndPassword: { enabled: true } });

  await first.transaction(async (transaction) => {
    await transaction.create({
      model: "user",
      data: {
        id: "captured-options",
        name: "Captured",
        email: "captured@example.com",
        emailVerified: false,
        role: "admin",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });
  });
  await expect(
    first.findOne({
      model: "user",
      where: [{ field: "id", value: "captured-options" }],
    }),
  ).resolves.toMatchObject({ role: "admin" });
});

test("transaction-bound factories reuse the root schema compatibility probe", async () => {
  const validateUser = vi.fn((value: unknown) => schemas.user["~standard"].validate(value));
  const countingModels = {
    ...MODELS,
    user: {
      ...MODELS.user,
      schema: {
        "~standard": {
          ...schemas.user["~standard"],
          validate: validateUser,
        },
      },
    },
  };
  const { adapter } = createHarness(countingModels);

  await createUser(adapter, "schema-cache", "schema-cache@example.com");
  const rootProbeCalls = validateUser.mock.calls.length;
  expect(rootProbeCalls).toBeGreaterThan(0);

  await adapter.transaction(async (transaction) => {
    await transaction.findOne({
      model: "user",
      where: [{ field: "id", value: "schema-cache" }],
    });
  });

  expect(validateUser).toHaveBeenCalledTimes(rootProbeCalls);
});

test("filters, sorting, offset, count, and bulk mutations follow the adapter contract", async () => {
  const { adapter } = createHarness();
  await createUser(adapter, "u1", "alice@example.com");
  await createUser(adapter, "u2", "bob@example.com");
  await createUser(adapter, "u3", "carol@other.test");

  const page = await adapter.findMany<Record<string, unknown>>({
    model: "user",
    where: [
      { field: "email", value: "example", operator: "contains" },
      {
        field: "email",
        value: "CAROL@OTHER.TEST",
        operator: "eq",
        connector: "OR",
        mode: "insensitive",
      },
    ],
    sortBy: { field: "email", direction: "desc" },
    offset: 1,
    limit: 2,
  });
  expect(page.map(({ id }) => id)).toEqual(["u2", "u1"]);

  await expect(
    adapter.count({
      model: "user",
      where: [
        {
          field: "id",
          value: ["u1", "u3"],
          operator: "in",
        },
      ],
    }),
  ).resolves.toBe(2);

  await expect(
    adapter.updateMany({
      model: "user",
      where: [
        {
          field: "email",
          value: "@example.com",
          operator: "ends_with",
        },
      ],
      update: { emailVerified: true },
    }),
  ).resolves.toBe(2);

  await expect(
    adapter.deleteMany({
      model: "user",
      where: [
        {
          field: "id",
          value: ["u1", "u2"],
          operator: "not_in",
        },
      ],
    }),
  ).resolves.toBe(1);
});

test("pushable filters and mutations avoid fallback scans", async () => {
  const { adapter, scanEvents, listCalls } = createHarness();
  await createUser(adapter, "u1", "alice@example.com");
  await createUser(adapter, "u2", "bob@example.com");
  scanEvents.length = 0;
  listCalls.length = 0;

  await adapter.findOne({
    model: "user",
    where: [{ field: "email", value: "alice", operator: "starts_with" }],
  });
  await adapter.findMany({
    model: "user",
    where: [{ field: "email", value: "@example.com", operator: "contains" }],
    limit: 10,
  });
  await adapter.count({
    model: "user",
    where: [{ field: "id", value: ["u1", "u2"], operator: "in" }],
  });
  await adapter.count({
    model: "user",
    where: [{ field: "createdAt", value: new Date("2026-02-01"), operator: "lt" }],
  });
  await adapter.updateMany({
    model: "user",
    where: [{ field: "email", value: ".com", operator: "ends_with" }],
    update: { emailVerified: true },
  });

  expect(scanEvents).toEqual([]);
  expect(listCalls.map(({ operation }) => operation)).toEqual([
    "list",
    "list",
    "count",
    "count",
    "updateMany",
  ]);
  expect(listCalls.some(({ operation }) => operation === "listAll")).toBe(false);

  await adapter.findMany({
    model: "user",
    where: [
      {
        field: "email",
        value: "ALICE@EXAMPLE.COM",
        operator: "eq",
        mode: "insensitive",
      },
    ],
    limit: 10,
  });
  await adapter.count({
    model: "user",
    where: [
      {
        field: "id",
        value: Array.from({ length: 33 }, (_, index) => `u${index}`),
        operator: "in",
      },
    ],
  });
  expect(scanEvents).toHaveLength(2);
  expect(listCalls.filter(({ operation }) => operation === "listAll")).toHaveLength(2);
});

test("consumeOne and incrementOne use the supplied transaction", async () => {
  const { adapter } = createHarness();
  await adapter.create({
    model: "verification",
    data: {
      id: "v1",
      identifier: "reset",
      value: "secret",
      expiresAt: new Date("2026-01-02T00:00:00.000Z"),
      attempts: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    forceAllowId: true,
  });

  await expect(
    adapter.consumeOne<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "value", value: "secret" }],
    }),
  ).resolves.toMatchObject({ id: "v1" });
  await expect(
    adapter.consumeOne<Record<string, unknown>>({
      model: "verification",
      where: [{ field: "value", value: "secret" }],
    }),
  ).resolves.toBeNull();

  await adapter.create({
    model: "verification",
    data: {
      id: "counter",
      identifier: "rate",
      value: "counter",
      expiresAt: new Date("2026-01-02T00:00:00.000Z"),
      attempts: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    forceAllowId: true,
  });
  await expect(
    adapter.incrementOne<Record<string, unknown>>({
      model: "verification",
      where: [
        { field: "id", value: "counter" },
        { field: "attempts", value: 0, operator: "gt" },
      ],
      increment: { attempts: -1 },
      set: { value: "used" },
    }),
  ).resolves.toMatchObject({ attempts: 0, value: "used" });
  await expect(
    adapter.incrementOne({
      model: "verification",
      where: [
        { field: "id", value: "counter" },
        { field: "attempts", value: 0, operator: "gt" },
      ],
      increment: { attempts: -1 },
    }),
  ).resolves.toBeNull();
});

test("Better Auth transactions commit and roll back across mapped collections", async () => {
  const { adapter, state } = createHarness();

  await adapter.transaction(async (transaction) => {
    await createUser(transaction as typeof adapter, "committed", "commit@example.com");
    await transaction.create({
      model: "session",
      data: {
        id: "s1",
        token: "token",
        expiresAt: new Date("2026-01-02T00:00:00.000Z"),
        userId: "committed",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });
  });
  expect(state.tables.authUsers?.has("committed")).toBe(true);
  expect(state.tables.authSessions?.has("s1")).toBe(true);

  await expect(
    adapter.transaction(async (transaction) => {
      await createUser(transaction as typeof adapter, "rolled-back", "rollback@example.com");
      await transaction.create({
        model: "session",
        data: {
          id: "s2",
          token: "rolled-back",
          expiresAt: new Date("2026-01-02T00:00:00.000Z"),
          userId: "rolled-back",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        forceAllowId: true,
      });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(state.tables.authUsers?.has("rolled-back")).toBe(false);
  expect(state.tables.authSessions?.has("s2")).toBe(false);
});

test("nested collection $transaction joins the same scoped collections", async () => {
  const { adapter, state } = createHarness();

  await adapter.transaction(async (transaction) => {
    await createUser(transaction as typeof adapter, "nested-commit", "nested-commit@example.com");
    await transaction.update({
      model: "user",
      where: [{ field: "id", value: "nested-commit" }],
      update: { name: "Nested Commit" },
    });
  });
  expect(state.tables.authUsers?.get("nested-commit")).toMatchObject({ name: "Nested Commit" });

  await expect(
    adapter.transaction(async (transaction) => {
      await createUser(
        transaction as typeof adapter,
        "nested-rollback",
        "nested-rollback@example.com",
      );
      await transaction.update({
        model: "user",
        where: [{ field: "id", value: "nested-rollback" }],
        update: { name: "should roll back" },
      });
      throw new Error("nested-rollback");
    }),
  ).rejects.toThrow("nested-rollback");
  expect(state.tables.authUsers?.has("nested-rollback")).toBe(false);
});

test("experimental one-to-many joins use mapped related collections", async () => {
  const { adapter, scanEvents, listCalls } = createHarness();
  await createUser(adapter, "u1", "join@example.com");
  for (const [id, token] of [
    ["s1", "first"],
    ["s2", "second"],
  ]) {
    await adapter.create({
      model: "session",
      data: {
        id,
        token,
        expiresAt: new Date("2026-01-02T00:00:00.000Z"),
        userId: "u1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });
  }
  scanEvents.length = 0;
  listCalls.length = 0;

  const user = await adapter.findOne<Record<string, unknown>>({
    model: "user",
    where: [{ field: "id", value: "u1" }],
    join: { session: { limit: 1 } },
  });
  expect(user?.session).toEqual([expect.objectContaining({ id: "s1", userId: "u1" })]);
  expect(scanEvents).toEqual([]);
  expect(listCalls).toContainEqual(
    expect.objectContaining({
      collection: "authSessions",
      operation: "list",
      options: expect.objectContaining({ limit: 1, where: expect.any(Function) }),
    }),
  );
  expect(listCalls.some(({ operation }) => operation === "listAll")).toBe(false);
});

test("email/password, bearer sessions, admin mutations, and password reset use Takibi", async () => {
  const { adapter, database } = createHarness();
  let resetUrl: string | undefined;
  let resetToken: string | undefined;
  const auth = betterAuth({
    database,
    baseURL: "http://auth.test",
    secret: "takibi-adapter-test-secret-at-least-32-characters",
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ token, url }) => {
        resetToken = token;
        resetUrl = url;
      },
    },
    plugins: [admin(), bearer()],
  });

  const owner = await auth.api.signUpEmail({
    body: {
      name: "Owner",
      email: "owner@example.com",
      password: "initial-password",
    },
  });
  const member = await auth.api.signUpEmail({
    body: {
      name: "Member",
      email: "member@example.com",
      password: "member-password",
    },
  });
  expect(owner.user.email).toBe("owner@example.com");

  await adapter.update({
    model: "user",
    where: [{ field: "id", value: owner.user.id }],
    update: { role: "admin" },
  });
  const signedIn = await auth.api.signInEmail({
    body: {
      email: "owner@example.com",
      password: "initial-password",
    },
  });
  const headers = new Headers({
    authorization: `Bearer ${signedIn.token}`,
  });
  await expect(auth.api.getSession({ headers })).resolves.toMatchObject({
    user: { id: owner.user.id, role: "admin" },
  });

  await expect(
    auth.api.setRole({
      headers,
      body: { userId: member.user.id, role: "admin" },
    }),
  ).resolves.toMatchObject({ user: { id: member.user.id, role: "admin" } });
  await expect(
    auth.api.banUser({
      headers,
      body: {
        userId: member.user.id,
        banReason: "contract test",
      },
    }),
  ).resolves.toMatchObject({ user: { id: member.user.id, banned: true } });
  await expect(
    auth.api.unbanUser({
      headers,
      body: { userId: member.user.id },
    }),
  ).resolves.toMatchObject({ user: { id: member.user.id, banned: false } });

  await auth.api.requestPasswordReset({
    body: {
      email: "owner@example.com",
      redirectTo: "http://app.test/reset",
    },
  });
  expect(resetUrl).toBeDefined();
  expect(resetToken).toBeTruthy();
  await auth.api.resetPassword({
    body: {
      token: resetToken!,
      newPassword: "updated-password",
    },
  });
  await expect(
    auth.api.signInEmail({
      body: {
        email: "owner@example.com",
        password: "updated-password",
      },
    }),
  ).resolves.toMatchObject({ user: { id: owner.user.id } });
});
