import { listWhere } from "@takibi/query";
import { z } from "zod";
import { createTakibi } from "../src/context";
import { fullAccess, none, grant } from "@takibi/policy";

export const watchApp = createTakibi<
  { partition: string; room?: string; expires?: number; extra?: string },
  Cloudflare.Env
>()({
  resolve: ({ context }) => ({
    room: context.room ?? "r",
    expires: context.expires ?? 9e15,
    extra: context.extra ?? "",
  }),
  stub: ({ context }): Pick<DurableObject, "fetch"> =>
    watchEnv!.TAKIBI_WATCH_TEST.get(watchEnv!.TAKIBI_WATCH_TEST.idFromName(context.partition)),
});
let watchEnv: Cloudflare.Env | undefined;
export function setWatchEnv(env: Cloudflare.Env) {
  watchEnv = env;
}
const app = watchApp.defineCollections({
  posts: {
    schema: z.object({ room: z.string(), score: z.number(), title: z.string() }),
    indexes: { byRoomScore: ["room", "score"], byScoreRoom: ["score", "room"] },
    accessPolicy: watchApp.policy({ reason: { code: "SESSION_EXPIRED" } }, ({ expires, room }) =>
      Date.now() < expires
        ? grant(
            "create",
            "get",
            "update",
            "delete",
            "invoke",
            listWhere<{ room: string }>((q) => q.room.eq(room)),
          )
        : none,
    ),
  },
  other: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
});
const actions = app.posts.actions((define) => ({
  policyWrite: define()
    .detached()
    .policy(fullAccess)
    .handler(async ({ collection }) => {
      await collection.update("kept", { score: 9 });
    }),
  addPair: define()
    .detached()
    .policy(fullAccess)
    .atomic()
    .handler(async ({ $collection }) => {
      await $collection.add({ room: "r", score: 1, title: "first" }, { id: "first" });
      await $collection.add({ room: "r", score: 2, title: "second" }, { id: "second" });
    }),
  rollback: define()
    .detached()
    .policy(fullAccess)
    .atomic()
    .handler(async ({ $collection }) => {
      await $collection.add({ room: "r", score: 3, title: "rollback" }, { id: "rollback" });
      throw new Error("rollback");
    }),
}));
export const watchHandler = app.actions({ posts: actions });
export class WatchTestObject extends watchHandler.DurableObject {}
declare global {
  namespace Cloudflare {
    interface Env {
      TAKIBI_WATCH_TEST: DurableObjectNamespace;
    }
  }
}
