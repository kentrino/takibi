# Trusted transactions

Generated Durable Objects expose local trusted transactions through
`this.$collections.$transaction(callback)`.

```ts
const result = await this.$collections.$transaction(async ($collections) => {
  await $collections.orders.add(order);
  await $collections.inventory.update(itemId, { stock });
  return order.id;
});
```

- The callback receives a transaction-bound `TrustedCollectionsApi`.
- A fulfilled callback commits every read and mutation and returns its result.
- A thrown error or rejected callback rolls back every mutation and rethrows the
  failure.
- Nested `$transaction` calls join the current transaction. They do not create
  savepoints or independently commit.
- Code inside the callback must use the passed `$collections` facade to remain
  on the transaction-bound storage driver.
- The facade remains trusted: collection access policies are bypassed, while
  schemas, uniqueness constraints, and storage invariants still apply.
- Transactions are limited to collections in one Durable Object instance.

`$transaction` is not available on the public client, policy-bound
`CollectionApi`, or the Durable Object RPC surface. The collection name
`$transaction` is reserved by `defineCollections()`.

## Callback execution count

`StorageDriver.transaction`, atomic action handlers, and trusted `$transaction`
callbacks execute at most once per call in one invocation attempt. Admission
failure may prevent execution entirely. Each explicitly supplied nested callback
has the same guarantee and joins its enclosing transaction without a savepoint.
The runtime, SQLite driver, and supported storage wrappers never transparently
replay application work after execution failure, rollback, commit failure, or an
unknown commit outcome. Replaying storage implementations are unsupported; the
runtime does not repair arbitrary replaying drivers. Error and settlement behavior
is unchanged by this guarantee.

This is not client retry deduplication or exactly-once external delivery. HTTP
requests, email, and other external effects cannot be rolled back. An effect may
already have happened when commit fails or its outcome is unknown, and a separate
invocation or client retry can perform it again. Use application idempotency or an
outbox when durable delivery is required.
