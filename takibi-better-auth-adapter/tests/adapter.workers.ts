import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createTakibi, fullAccess, TAKIBI_TRUSTED_TRANSACTION } from "@takibi/takibi";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { takibiAdapter } from "../src/adapter.server.ts";
import { defineBetterAuthCollections } from "../src/collections.server.ts";
import type { AdapterTestObject } from "./worker";

const tenantId = "better-auth-adapter";
const context = createTakibi()({ resolve: () => ({ tenantId }) });
const authCollections = defineBetterAuthCollections({
  user: z.object({
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable().optional(),
  }),
  session: z.object({
    expiresAt: z.iso.datetime(),
    token: z.string(),
    ipAddress: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
    userId: z.string(),
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
});
const handler = context
  .defineCollections({
    ...authCollections,
    auditEvents: {
      schema: z.object({ action: z.string() }),
      accessPolicy: fullAccess,
    },
  })
  .actions({});

const models = {
  user: {
    collection: "authUsers",
    schema: authCollections.authUsers.schema,
    indexes: authCollections.authUsers.indexes,
  },
  session: {
    collection: "authSessions",
    schema: authCollections.authSessions.schema,
    indexes: authCollections.authSessions.indexes,
  },
  account: {
    collection: "authAccounts",
    schema: authCollections.authAccounts.schema,
    indexes: authCollections.authAccounts.indexes,
  },
  verification: {
    collection: "authVerifications",
    schema: authCollections.authVerifications.schema,
    indexes: authCollections.authVerifications.indexes,
  },
} as const;

test("actual Durable Object SQLite provides adapter atomicity and private auth collections", async () => {
  const stub = env.TAKIBI_ADAPTER_TEST.getByName(tenantId) as DurableObjectStub<AdapterTestObject>;
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    const object = new handler.DurableObject(state, {});
    const adapter = takibiAdapter({
      collections: object.$collections,
      transaction: (callback) => object[TAKIBI_TRUSTED_TRANSACTION](callback),
      models,
    })({
      emailAndPassword: { enabled: true },
      advanced: { database: { generateId: false } },
      verification: {
        additionalFields: {
          attempts: { type: "number", required: false },
        },
      },
    });

    const createUser = (id: string, email: string) =>
      adapter.create({
        model: "user",
        data: {
          id,
          name: id,
          email,
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        forceAllowId: true,
      });

    const duplicateEmail = await Promise.allSettled([
      createUser("parallel-1", "parallel@example.com"),
      createUser("parallel-2", "parallel@example.com"),
    ]);
    expect(duplicateEmail.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(duplicateEmail.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const generated = await adapter.create<Record<string, unknown>>({
      model: "user",
      data: {
        name: "generated",
        email: "generated@example.com",
        emailVerified: false,
        createdAt: new Date("2024-01-02T03:04:05.000Z"),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });
    expect(generated.id).toEqual(expect.any(String));
    expect(generated.createdAt).toEqual(new Date("2024-01-02T03:04:05.000Z"));
    await expect(
      adapter.findMany({
        model: "user",
        where: [{ field: "image", value: null }],
        limit: 10,
        select: ["id", "email"],
      }),
    ).resolves.toContainEqual({
      id: generated.id,
      email: "generated@example.com",
    });

    await adapter.create({
      model: "verification",
      data: {
        id: "verification-1",
        identifier: "password-reset",
        value: "single-use-token",
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });
    const consumed = await Promise.all([
      adapter.consumeOne<Record<string, unknown>>({
        model: "verification",
        where: [{ field: "value", value: "single-use-token" }],
      }),
      adapter.consumeOne<Record<string, unknown>>({
        model: "verification",
        where: [{ field: "value", value: "single-use-token" }],
      }),
    ]);
    expect(consumed.filter((value) => value !== null)).toHaveLength(1);
    expect(consumed.filter((value) => value === null)).toHaveLength(1);

    await adapter.create({
      model: "verification",
      data: {
        id: "counter",
        identifier: "rate-limit",
        value: "counter",
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });
    const incremented = await Promise.all([
      adapter.incrementOne<Record<string, unknown>>({
        model: "verification",
        where: [{ field: "id", value: "counter" }],
        increment: { attempts: 1 },
      }),
      adapter.incrementOne<Record<string, unknown>>({
        model: "verification",
        where: [{ field: "id", value: "counter" }],
        increment: { attempts: 1 },
      }),
    ]);
    expect(
      incremented
        .map((document) => document?.attempts)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([1, 2]);
    await expect(
      adapter.findOne<Record<string, unknown>>({
        model: "verification",
        where: [{ field: "id", value: "counter" }],
      }),
    ).resolves.toMatchObject({ attempts: 2 });

    await expect(
      object[TAKIBI_TRUSTED_TRANSACTION](async ($collections) => {
        await $collections.auditEvents.add({ action: "rolled-back" }, { id: "audit-rollback" });
        const transactionAdapter = takibiAdapter({
          collections: $collections,
          transaction: async (callback) => callback($collections),
          models,
        })({
          emailAndPassword: { enabled: true },
        });
        await transactionAdapter.create({
          model: "session",
          data: {
            id: "session-rollback",
            token: "rollback-token",
            expiresAt: new Date("2026-09-01T00:00:00.000Z"),
            userId: "parallel-1",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          forceAllowId: true,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await expect(object.$collections.auditEvents.get("audit-rollback")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(object.$collections.authSessions.get("session-rollback")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const publicResponse = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify({
          kind: "collection",
          collection: "authUsers",
          operation: "list",
          context: { tenantId },
        }),
      }),
    );
    expect(publicResponse.status).toBe(403);
  });
});
