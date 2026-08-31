type ZodModule = Pick<typeof import("zod"), "boolean" | "iso" | "object" | "string">;

/**
 * Create storage-form Zod schemas for Better Auth's four core models.
 *
 * Zod is supplied by the application so the adapter has no runtime dependency
 * on a particular schema library or Zod installation.
 */
export function createZodBetterAuthBaseSchemas(z: ZodModule) {
  return {
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
    }),
  };
}
