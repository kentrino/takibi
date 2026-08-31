/**
 * Local-only capability for transaction-bound trusted collections.
 *
 * A symbol key keeps this method off the Durable Object's string-named RPC
 * surface while allowing code running inside the object to use it.
 */
export const TAKIBI_TRUSTED_TRANSACTION: unique symbol = Symbol("takibi.trustedTransaction");

/** Local-only capability for clearing and reseeding a Durable Object. */
export const TAKIBI_TRUSTED_RESET_STORAGE: unique symbol = Symbol("takibi.trustedResetStorage");
