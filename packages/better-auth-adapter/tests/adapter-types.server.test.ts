import type { ClientCollectionApi, CollectionsApi, TrustedCollectionsApi } from "takibi";
import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { takibiAdapter, type TakibiAdapterOptions } from "../src/adapter.server.ts";

const defs = {
  authUsers: { schema: z.object({ email: z.string() }) },
  authSessions: { schema: z.object({ token: z.string() }) },
  authAccounts: { schema: z.object({ userId: z.string() }) },
  authVerifications: { schema: z.object({ value: z.string() }) },
};

const models = {
  user: { collection: "authUsers", schema: defs.authUsers.schema },
  session: { collection: "authSessions", schema: defs.authSessions.schema },
  account: { collection: "authAccounts", schema: defs.authAccounts.schema },
  verification: { collection: "authVerifications", schema: defs.authVerifications.schema },
} as const;

type Trusted = TrustedCollectionsApi<typeof defs>;
type PolicyBound = CollectionsApi<typeof defs>;
type PublicClient = {
  authUsers: ClientCollectionApi<(typeof defs)["authUsers"]>;
  authSessions: ClientCollectionApi<(typeof defs)["authSessions"]>;
  authAccounts: ClientCollectionApi<(typeof defs)["authAccounts"]>;
  authVerifications: ClientCollectionApi<(typeof defs)["authVerifications"]>;
};

test("adapter options bind transaction to trusted collections", () => {
  expectTypeOf<TakibiAdapterOptions<Trusted>>().toHaveProperty("collections");
  expectTypeOf<TakibiAdapterOptions<Trusted>>().toHaveProperty("models");
  expectTypeOf<TakibiAdapterOptions<Trusted>>().not.toHaveProperty("transaction");

  takibiAdapter({
    collections: {} as Trusted,
    models,
  });

  takibiAdapter({
    collections: {} as Trusted,
    models,
    // @ts-expect-error transaction is owned by collections, not an adapter option
    transaction: (run: (collections: Trusted) => Promise<unknown>) => run({} as Trusted),
  });

  takibiAdapter({
    // @ts-expect-error policy-bound collections have no $transaction
    collections: {} as PolicyBound,
    models,
  });

  takibiAdapter({
    // @ts-expect-error public clients have no $transaction
    collections: {} as PublicClient,
    models,
  });

  takibiAdapter({
    collections: {} as Trusted,
    models: {
      ...models,
      user: {
        // @ts-expect-error $transaction is not a mapped collection name
        collection: "$transaction",
        schema: defs.authUsers.schema,
      },
    },
  });
});
