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
