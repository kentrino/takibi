import { readFileSync } from "node:fs";
import { join } from "node:path";
import { none } from "@takibi/takibi";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import {
  createZodBetterAuthBaseSchemas,
  defineBetterAuthCollections,
} from "../src/index.server.ts";

const base = createZodBetterAuthBaseSchemas(z);

test("creates extensible storage-form schemas for the four core models", () => {
  const user = base.user
    .extend({ role: z.enum(["member", "owner"]) })
    .superRefine((value, context) => {
      if (value.role === "owner" && !value.emailVerified) {
        context.addIssue({
          code: "custom",
          message: "owners must be verified",
        });
      }
    })
    .transform((value) => ({ ...value, email: value.email.toLowerCase() }));

  expect(
    user.parse({
      name: "Member",
      email: "MEMBER@EXAMPLE.COM",
      emailVerified: false,
      role: "member",
    }),
  ).toMatchObject({ email: "member@example.com", role: "member" });
  expect(() =>
    user.parse({
      name: "Owner",
      email: "owner@example.com",
      emailVerified: false,
      role: "owner",
    }),
  ).toThrow("owners must be verified");

  expect(
    base.session.parse({
      expiresAt: "2026-09-01T00:00:00.000Z",
      token: "token",
      userId: "user",
      ipAddress: null,
    }),
  ).toMatchObject({ ipAddress: null });
  expect(() =>
    base.session.parse({
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      token: "token",
      userId: "user",
    }),
  ).toThrow();

  expect(
    base.account.parse({
      accountId: "account",
      providerId: "credential",
      userId: "user",
    }),
  ).toEqual({
    accountId: "account",
    providerId: "credential",
    userId: "user",
  });
  expect(
    base.verification.parse({
      identifier: "password-reset",
      value: "secret",
      expiresAt: "2026-09-01T00:00:00.000Z",
    }),
  ).toMatchObject({ identifier: "password-reset" });
});

test("bare schemas receive all required unique constraints and covering indexes", () => {
  const collections = defineBetterAuthCollections({
    user: base.user,
    session: base.session,
    account: base.account,
    verification: base.verification,
  });

  expect(collections.authUsers).toMatchObject({
    accessPolicy: none,
    unique: { byEmail: ["email"] },
    indexes: { byEmail: ["email"] },
  });
  expect(collections.authSessions).toMatchObject({
    accessPolicy: none,
    unique: { byToken: ["token"] },
    indexes: {
      byToken: ["token"],
      byUser: ["userId", "createdAt"],
    },
  });
  expect(collections.authAccounts).toMatchObject({
    accessPolicy: none,
    unique: { byProviderAccount: ["providerId", "accountId"] },
    indexes: {
      byProviderAccount: ["providerId", "accountId"],
      byUser: ["userId", "createdAt"],
    },
  });
  expect(collections.authVerifications).toMatchObject({
    accessPolicy: none,
    unique: { byIdentifierValue: ["identifier", "value"] },
    indexes: {
      byIdentifierValue: ["identifier", "value"],
      byExpiry: ["expiresAt", "createdAt"],
    },
  });
});

test("extends adds collection options without replacing library-owned defaults", () => {
  const userSchema = base.user.extend({
    staffRole: z.string(),
    employeeNumber: z.string(),
  });
  const seed = () => ({
    owner: {
      name: "Owner",
      email: "owner@example.com",
      emailVerified: true,
      staffRole: "doctor",
      employeeNumber: "EMP-1",
    },
  });
  const migrations = {
    steps: [(value: unknown) => userSchema.parse(value)],
  } as const;

  const collections = defineBetterAuthCollections({
    user: {
      extends: {
        schema: userSchema,
        indexes: { byStaffRole: ["staffRole", "createdAt"] },
        unique: { byEmployeeNumber: ["employeeNumber"] },
        seed,
        migrations,
      },
    },
    session: base.session,
    account: base.account,
    verification: base.verification,
  });
  const models = {
    user: {
      collection: "authUsers",
      schema: collections.authUsers.schema,
      indexes: collections.authUsers.indexes,
    },
  } as const;

  expect(collections.authUsers.schema).toBe(userSchema);
  expect(collections.authUsers.seed).toBe(seed);
  expect(collections.authUsers.migrations).toBe(migrations);
  expect(collections.authUsers.unique).toEqual({
    byEmail: ["email"],
    byEmployeeNumber: ["employeeNumber"],
  });
  expect(models.user.indexes).toEqual({
    byEmail: ["email"],
    byStaffRole: ["staffRole", "createdAt"],
  });
  expect(collections.authUsers.seed?.()).toEqual(seed());
  expectTypeOf(models.user.indexes.byStaffRole).toEqualTypeOf<
    readonly ["staffRole", "createdAt"]
  >();
});

test.each([
  ["user", "indexes", "byEmail"],
  ["session", "unique", "byUser"],
] as const)("rejects reserved %s %s name %s synchronously", (model, kind, name) => {
  const reserved = { [name]: ["email"] } as unknown as Record<never, never>;
  const schemas = {
    user: base.user,
    session: base.session,
    account: base.account,
    verification: base.verification,
  };
  const schema = schemas[model];

  expect(() =>
    defineBetterAuthCollections({
      ...schemas,
      [model]: {
        extends: {
          schema,
          [kind]: reserved,
        },
      },
    }),
  ).toThrow(new RegExp(`Better Auth ${model} ${kind}.*${name}`));
});

test("reserved names are rejected by the public input type", () => {
  const defineInvalidCollections = () =>
    defineBetterAuthCollections({
      // @ts-expect-error the helper owns the byEmail index name
      user: {
        extends: {
          schema: base.user,
          indexes: {
            byEmail: ["email"],
          },
        },
      },
      session: base.session,
      account: base.account,
      verification: base.verification,
    });

  expect(defineInvalidCollections).toBeTypeOf("function");
});

test("Zod remains a peer and is absent from runtime imports", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const source = readFileSync(join(import.meta.dirname, "../src/zod-schemas.ts"), "utf8");

  expect(manifest.dependencies?.zod).toBeUndefined();
  expect(manifest.devDependencies?.zod).toBe("catalog:");
  expect(manifest.peerDependencies?.zod).toBe("^4.4.3");
  expect(source).not.toMatch(/import\s+(?!type\b).*["']zod["']/);
});
