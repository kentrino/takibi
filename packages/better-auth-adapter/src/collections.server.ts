import type { StandardSchemaV1 } from "@standard-schema/spec";
import { none } from "takibi";

type ReservedDocumentDataKey = "id" | "createdAt" | "updatedAt" | "rev" | "$schemaVersion";

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

type CollectionField<TSchema extends StandardSchemaV1> =
  | (keyof StandardSchemaV1.InferOutput<TSchema> & string)
  | "id"
  | "createdAt"
  | "updatedAt";

type CollectionUnique<TSchema extends StandardSchemaV1> = Readonly<
  Record<string, readonly [CollectionField<TSchema>, ...CollectionField<TSchema>[]]>
>;

type CollectionIndexes<TSchema extends StandardSchemaV1> = Readonly<
  Record<string, readonly [CollectionField<TSchema>, ...CollectionField<TSchema>[]]>
>;

type MigrationStep<TOutput = unknown> = (data: unknown) => TOutput;
type CollectionMigrations<TSchema extends StandardSchemaV1> = {
  base?: number;
  steps:
    | readonly []
    | readonly [...MigrationStep[], MigrationStep<StandardSchemaV1.InferInput<TSchema>>];
};

type CollectionSeed<TSchema extends StandardSchemaV1> = () =>
  | Readonly<Record<string, Omit<StandardSchemaV1.InferInput<TSchema>, ReservedDocumentDataKey>>>
  | Promise<
      Readonly<Record<string, Omit<StandardSchemaV1.InferInput<TSchema>, ReservedDocumentDataKey>>>
    >;

const RESERVED_CONSTRAINT_NAMES = [
  "byEmail",
  "byToken",
  "byProviderAccount",
  "byIdentifierValue",
  "byUser",
  "byExpiry",
] as const;

type ReservedConstraintName = (typeof RESERVED_CONSTRAINT_NAMES)[number];

type CollectionOptionShape = {
  indexes?: Readonly<Record<string, readonly [string, ...string[]]>>;
  unique?: Readonly<Record<string, readonly [string, ...string[]]>>;
  seed?: () => unknown;
  migrations?: {
    base?: number;
    steps: readonly MigrationStep[];
  };
};

type BetterAuthCollectionExtension<TFields> = {
  extends: {
    schema: StandardSchemaV1<unknown, TFields>;
  } & CollectionOptionShape;
};

type BetterAuthCollectionInput<TFields> =
  | StandardSchemaV1<unknown, TFields>
  | BetterAuthCollectionExtension<TFields>;

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
  user: TUser | { extends: { schema: TUser } & CollectionOptionShape };
  session: TSession | { extends: { schema: TSession } & CollectionOptionShape };
  account: TAccount | { extends: { schema: TAccount } & CollectionOptionShape };
  verification: TVerification | { extends: { schema: TVerification } & CollectionOptionShape };
};

type BetterAuthCollectionInputMap = {
  user: BetterAuthCollectionInput<UserFields>;
  session: BetterAuthCollectionInput<SessionFields>;
  account: BetterAuthCollectionInput<AccountFields>;
  verification: BetterAuthCollectionInput<VerificationFields>;
};

type SchemaOf<TInput> = TInput extends {
  extends: { schema: infer TSchema extends StandardSchemaV1 };
}
  ? TSchema
  : TInput extends StandardSchemaV1
    ? TInput
    : never;

type OptionOf<TInput, TName extends keyof CollectionOptionShape> = TInput extends {
  extends: infer TExtension;
}
  ? TName extends keyof TExtension
    ? NonNullable<TExtension[TName]>
    : Record<never, never>
  : Record<never, never>;

type ValidateCollectionInput<TInput> =
  OptionOf<TInput, "indexes"> extends CollectionIndexes<SchemaOf<TInput>>
    ? OptionOf<TInput, "unique"> extends CollectionUnique<SchemaOf<TInput>>
      ? OptionOf<TInput, "seed"> extends Record<never, never> | CollectionSeed<SchemaOf<TInput>>
        ? OptionOf<TInput, "migrations"> extends
            | Record<never, never>
            | CollectionMigrations<SchemaOf<TInput>>
          ? Extract<
              keyof OptionOf<TInput, "indexes"> | keyof OptionOf<TInput, "unique">,
              ReservedConstraintName
            > extends never
            ? unknown
            : never
          : never
        : never
      : never
    : never;

type AddedCollectionOptions<TInput> = TInput extends {
  extends: infer TExtension;
}
  ? Pick<TExtension, Extract<keyof TExtension, "seed" | "migrations">>
  : Record<never, never>;

type DefinedCollection<TInput, TDefaultIndexes, TDefaultUnique> = AddedCollectionOptions<TInput> & {
  schema: SchemaOf<TInput>;
  accessPolicy: typeof none;
  indexes: TDefaultIndexes & OptionOf<TInput, "indexes">;
  unique: TDefaultUnique & OptionOf<TInput, "unique">;
};

type BetterAuthCollectionsResult<TInputs extends BetterAuthCollectionInputMap> = {
  authUsers: DefinedCollection<
    TInputs["user"],
    { readonly byEmail: readonly ["email"] },
    { readonly byEmail: readonly ["email"] }
  >;
  authSessions: DefinedCollection<
    TInputs["session"],
    {
      readonly byToken: readonly ["token"];
      readonly byUser: readonly ["userId", "createdAt"];
    },
    { readonly byToken: readonly ["token"] }
  >;
  authAccounts: DefinedCollection<
    TInputs["account"],
    {
      readonly byProviderAccount: readonly ["providerId", "accountId"];
      readonly byUser: readonly ["userId", "createdAt"];
    },
    {
      readonly byProviderAccount: readonly ["providerId", "accountId"];
    }
  >;
  authVerifications: DefinedCollection<
    TInputs["verification"],
    {
      readonly byIdentifierValue: readonly ["identifier", "value"];
      readonly byExpiry: readonly ["expiresAt", "createdAt"];
    },
    {
      readonly byIdentifierValue: readonly ["identifier", "value"];
    }
  >;
};

/**
 * Define the four Better Auth core models as private Takibi collections.
 *
 * The application owns the schemas because Better Auth plugins and
 * `additionalFields` can extend every core model. The adapter validates these
 * schemas against the Better Auth runtime model before serving operations.
 */
export function defineBetterAuthCollections<const TInputs extends BetterAuthCollectionInputMap>(
  schemas: TInputs & {
    [TModel in keyof BetterAuthCollectionInputMap]: ValidateCollectionInput<TInputs[TModel]>;
  },
): BetterAuthCollectionsResult<TInputs> {
  const user = collectionExtension(schemas.user);
  const session = collectionExtension(schemas.session);
  const account = collectionExtension(schemas.account);
  const verification = collectionExtension(schemas.verification);

  assertNoReservedNames("user", user);
  assertNoReservedNames("session", session);
  assertNoReservedNames("account", account);
  assertNoReservedNames("verification", verification);

  const authUsers = {
    ...additionalCollectionOptions(user),
    schema: user.schema,
    accessPolicy: none,
    unique: {
      byEmail: ["email"],
      ...user.unique,
    },
    indexes: {
      byEmail: ["email"],
      ...user.indexes,
    },
  } as const;

  const authSessions = {
    ...additionalCollectionOptions(session),
    schema: session.schema,
    accessPolicy: none,
    unique: {
      byToken: ["token"],
      ...session.unique,
    },
    indexes: {
      byToken: ["token"],
      byUser: ["userId", "createdAt"],
      ...session.indexes,
    },
  } as const;

  const authAccounts = {
    ...additionalCollectionOptions(account),
    schema: account.schema,
    accessPolicy: none,
    unique: {
      byProviderAccount: ["providerId", "accountId"],
      ...account.unique,
    },
    indexes: {
      byProviderAccount: ["providerId", "accountId"],
      byUser: ["userId", "createdAt"],
      ...account.indexes,
    },
  } as const;

  const authVerifications = {
    ...additionalCollectionOptions(verification),
    schema: verification.schema,
    accessPolicy: none,
    unique: {
      byIdentifierValue: ["identifier", "value"],
      ...verification.unique,
    },
    indexes: {
      byIdentifierValue: ["identifier", "value"],
      byExpiry: ["expiresAt", "createdAt"],
      ...verification.indexes,
    },
  } as const;

  return {
    authUsers,
    authSessions,
    authAccounts,
    authVerifications,
  } as unknown as BetterAuthCollectionsResult<TInputs>;
}

type NormalizedCollectionExtension<TFields> = {
  schema: StandardSchemaV1<unknown, TFields>;
} & CollectionOptionShape;

function collectionExtension<TFields>(
  input: BetterAuthCollectionInput<TFields>,
): NormalizedCollectionExtension<TFields> {
  return isCollectionExtension(input) ? input.extends : { schema: input };
}

function isCollectionExtension<TFields>(
  input: BetterAuthCollectionInput<TFields>,
): input is BetterAuthCollectionExtension<TFields> {
  return typeof input === "object" && input !== null && "extends" in input;
}

function additionalCollectionOptions<TFields>(extension: NormalizedCollectionExtension<TFields>) {
  return {
    ...("seed" in extension ? { seed: extension.seed } : {}),
    ...("migrations" in extension ? { migrations: extension.migrations } : {}),
  };
}

function assertNoReservedNames<TFields>(
  model: string,
  extension: NormalizedCollectionExtension<TFields>,
): void {
  for (const kind of ["indexes", "unique"] as const) {
    const values = extension[kind];
    if (!values) continue;
    for (const name of RESERVED_CONSTRAINT_NAMES) {
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        throw new TypeError(`Better Auth ${model} ${kind} cannot override reserved name "${name}"`);
      }
    }
  }
}
