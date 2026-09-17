import { expectTypeOf, it } from "vite-plus/test";
import { z } from "zod";
import { createWatchClient } from "../src/watch";
import type { WatchSubscription, TakibiDefinitionCarrier } from "@takibi/api";
import { createPolicyHelper, none } from "@takibi/policy";
const schema = z.object({ room: z.string(), score: z.number(), active: z.boolean() });
const policy = createPolicyHelper<{}>()({ reason: { code: "EXPIRED" } }, none);
type Handler = TakibiDefinitionCarrier & {
  "~takibi": {
    collections: {
      posts: {
        schema: typeof schema;
        indexes: { byRoomScore: readonly ["room", "score"] };
        accessPolicy: typeof policy;
      };
    };
    actions: {};
  };
};
const client = createWatchClient<Handler>("https://example.com");
it("preserves index-dependent query types and terminal policy reasons", () => {
  function check() {
    const handle = client.posts.watch(
      {
        index: "byRoomScore",
        where: (q) => q.room.eq("r"),
        orderBy: (q) => q.score.desc(),
        limit: 2,
      },
      {
        next(page) {
          expectTypeOf(page.items[0]!.score).toEqualTypeOf<number>();
          // @ts-expect-error snapshots do not paginate
          void page.nextCursor;
        },
      },
    );
    expectTypeOf(handle).toEqualTypeOf<WatchSubscription<"EXPIRED">>();
    // @ts-expect-error no cursor
    client.posts.watch({ cursor: "x" }, { next() {} });
    // @ts-expect-error unknown index
    client.posts.watch({ index: "bad" }, { next() {} });
    // @ts-expect-error orderBy requires index
    client.posts.watch({ orderBy: (q) => q.score.asc() }, { next() {} });
    // @ts-expect-error field is outside selected index
    client.posts.watch({ index: "byRoomScore", orderBy: (q) => q.active.asc() }, { next() {} });
    // @ts-expect-error unknown field
    client.posts.watch({ where: (q) => q.nope.eq(1) }, { next() {} });
    // @ts-expect-error invalid field value
    client.posts.watch({ where: (q) => q.score.eq("x") }, { next() {} });
    // @ts-expect-error invalid operator for boolean field
    client.posts.watch({ where: (q) => q.active.gt(true) }, { next() {} });
    return handle;
  }
  expectTypeOf(check).toBeFunction();
});
