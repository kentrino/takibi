import { defineBetterAuthCollections, takibiAdapter } from "@takibi/takibi-better-auth-adapter";
import { expect, test } from "vite-plus/test";
import { z } from "zod";

test("package root exports adapter and collection helpers", () => {
  expect(takibiAdapter).toBeTypeOf("function");

  const collections = defineBetterAuthCollections({
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
    }),
    verification: z.object({
      identifier: z.string(),
      value: z.string(),
      expiresAt: z.iso.datetime(),
    }),
  });

  expect(Object.keys(collections)).toEqual([
    "authUsers",
    "authSessions",
    "authAccounts",
    "authVerifications",
  ]);
});
