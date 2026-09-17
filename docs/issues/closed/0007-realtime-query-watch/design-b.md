# Design B: Application polling with the existing list API

Periodically call list with the same where/limit and compare items before rendering. Authentication refreshes through headers/resolve on each HTTP request; no DO attachment or commit observer is added. The application owns timers, visibility handling, errors, and suppression of callbacks after shutdown.

## Example

```ts
// Before: Refresh only on an explicit user action
const page = await client.posts.list({ where: (q) => q.roomId.eq(roomId), limit: 50 });
// After: Application helper, not a new Takibi API
const stop = pollPosts(
  async () =>
    client.posts.list({
      where: (q) => q.roomId.eq(roomId),
      limit: 50,
    }),
  (page) => setPosts(page.items),
);
stop();
```

The helper prevents overlapping requests and ignores requests that complete after stop. Existing APIs and storage formats remain unchanged. Normal list policy and partition rules apply, but updates wait until the next poll, and queries consume resources even when nothing changes. Cleanup after the user stops polling and existing read tests can verify this independently.

Compare latency, query count, and callbacks after disconnection using the same chat workload as A. This does not satisfy immediate post-mutation notification or Hibernation, so it is rejected under the current requirements. Doing nothing leaves the same application burden. Retain this as a lower-cost option if acceptable update latency is high and subscription counts are confirmed to be low.
