import type { StandardSchemaV1 } from "@standard-schema/spec";
import { none } from "@takibi/takibi";

type UserFields = {
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
};

type SessionFields = {
  expiresAt: string;
  token: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
};

type AccountFields = {
  accountId: string;
  providerId: string;
  userId: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  accessTokenExpiresAt?: string | null;
  refreshTokenExpiresAt?: string | null;
  scope?: string | null;
  password?: string | null;
};

type VerificationFields = {
  identifier: string;
  value: string;
  expiresAt: string;
};

export type BetterAuthCollectionSchemas<
  TUser extends StandardSchemaV1<unknown, UserFields> = StandardSchemaV1<unknown, UserFields>,
  TSession extends StandardSchemaV1<unknown, SessionFields> = StandardSchemaV1<
    unknown,
    SessionFields
  >,
  TAccount extends StandardSchemaV1<unknown, AccountFields> = StandardSchemaV1<
    unknown,
    AccountFields
  >,
  TVerification extends StandardSchemaV1<unknown, VerificationFields> = StandardSchemaV1<
    unknown,
    VerificationFields
  >,
> = {
  user: TUser;
  session: TSession;
  account: TAccount;
  verification: TVerification;
};

/**
 * Define the four Better Auth core models as private Takibi collections.
 *
 * The application owns the schemas because Better Auth plugins and
 * `additionalFields` can extend every core model. The adapter validates these
 * schemas against the Better Auth runtime model before serving operations.
 */
export function defineBetterAuthCollections<
  TUser extends StandardSchemaV1<unknown, UserFields>,
  TSession extends StandardSchemaV1<unknown, SessionFields>,
  TAccount extends StandardSchemaV1<unknown, AccountFields>,
  TVerification extends StandardSchemaV1<unknown, VerificationFields>,
>(schemas: BetterAuthCollectionSchemas<TUser, TSession, TAccount, TVerification>) {
  const authUsers = {
    schema: schemas.user,
    accessPolicy: none,
    unique: {
      byEmail: ["email"],
    },
    indexes: {
      byEmail: ["email"],
    },
  } as const;

  const authSessions = {
    schema: schemas.session,
    accessPolicy: none,
    unique: {
      byToken: ["token"],
    },
    indexes: {
      byToken: ["token"],
      byUser: ["userId", "createdAt"],
    },
  } as const;

  const authAccounts = {
    schema: schemas.account,
    accessPolicy: none,
    unique: {
      byProviderAccount: ["providerId", "accountId"],
    },
    indexes: {
      byProviderAccount: ["providerId", "accountId"],
      byUser: ["userId", "createdAt"],
    },
  } as const;

  const authVerifications = {
    schema: schemas.verification,
    accessPolicy: none,
    unique: {
      byIdentifierValue: ["identifier", "value"],
    },
    indexes: {
      byIdentifierValue: ["identifier", "value"],
      byExpiry: ["expiresAt", "createdAt"],
    },
  } as const;

  return {
    authUsers,
    authSessions,
    authAccounts,
    authVerifications,
  };
}
