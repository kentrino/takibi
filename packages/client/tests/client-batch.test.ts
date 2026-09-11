import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { MAX_BATCH_ITEMS } from "@takibi/protocol";
import { createClient } from "@takibi/client";

const Post = z.object({ title: z.string() });

type PostsCarrier = {
  readonly "~takibi": {
    readonly collections: {
      readonly posts: { readonly schema: typeof Post };
    };
    readonly actions: {
      readonly $: {
        readonly exportAll: {
          readonly inputSchema: undefined;
          readonly handler: () => Promise<{ ok: true }>;
        };
      };
    };
  };
};

type FetchCall = {
  method: string;
  url: string;
  headerKeys: string[];
  body?: unknown;
};

function captureFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const call: FetchCall = {
      method: request.method,
      url: request.url,
      headerKeys: [...request.headers.keys()],
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch: fetchImpl };
}

function okBatch(call: FetchCall): Response {
  const count = Array.isArray((call.body as { items?: unknown })?.items)
    ? (call.body as { items: unknown[] }).items.length
    : 0;
  return Response.json({
    ok: true,
    data: Array.from({ length: count }, (_, index) => ({
      ok: true,
      data: { id: `item-${index}` },
    })),
  });
}

function okSingle(): Response {
  return Response.json({ ok: true, data: { id: "solo" } });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("omitting batch sends each call immediately to its REST endpoint", async () => {
  const { calls, fetch } = captureFetch(() => okSingle());
  const client = createClient<PostsCarrier>("http://fire.test/api", { fetch });

  const first = client.posts.get("p1");
  const second = client.posts.list();
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
    "GET http://fire.test/api/posts/p1",
    "GET http://fire.test/api/posts",
  ]);
  await expect(first).resolves.toMatchObject({ ok: true });
  await expect(second).resolves.toMatchObject({ ok: true });
});

test("fixed window waits until maxWaitMs and does not extend the deadline", async () => {
  const { calls, fetch } = captureFetch(okBatch);
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 10 },
    fetch,
  });

  const first = client.posts.get("p1");
  expect(calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5);
  const second = client.posts.get("p2");
  await vi.advanceTimersByTimeAsync(4);
  expect(calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    method: "POST",
    url: "http://fire.test/_batch",
    body: {
      kind: "batch",
      items: [
        { kind: "collection", collection: "posts", operation: "get", id: "p1" },
        { kind: "collection", collection: "posts", operation: "get", id: "p2" },
      ],
    },
  });
  await expect(first).resolves.toEqual({ ok: true, data: { id: "item-0" } });
  await expect(second).resolves.toEqual({ ok: true, data: { id: "item-1" } });
});

test("maxWaitMs 0 batches synchronous reads into the next timer task", async () => {
  const { calls, fetch } = captureFetch(okBatch);
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch,
  });

  const first = client.posts.get("p1");
  const second = client.posts.list({ limit: 2 });
  expect(calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({
    kind: "batch",
    items: [
      { kind: "collection", collection: "posts", operation: "get", id: "p1" },
      { kind: "collection", collection: "posts", operation: "list", list: { limit: 2 } },
    ],
  });
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
});

test("maxSize 1 flushes every read immediately", async () => {
  const { calls, fetch } = captureFetch(okBatch);
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0, maxSize: 1 },
    fetch,
  });

  const first = client.posts.get("p1");
  const second = client.posts.list();

  expect(calls).toHaveLength(2);
  expect((calls[0]!.body as { items: unknown[] }).items).toHaveLength(1);
  expect((calls[1]!.body as { items: unknown[] }).items).toHaveLength(1);
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
});

test("writes and actions bypass the queue without changing a pending read deadline", async () => {
  const { calls, fetch } = captureFetch((call) =>
    call.url.endsWith("/_batch") ? okBatch(call) : okSingle(),
  );
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 10 },
    fetch,
  });

  const pendingRead = client.posts.get("p1");
  const added = client.posts.add({ title: "n" });
  const action = client.exportAll();
  await Promise.all([added, action]);
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
    "POST http://fire.test/posts",
    "POST http://fire.test/$:exportAll",
  ]);

  await vi.advanceTimersByTimeAsync(10);
  expect(calls).toHaveLength(3);
  expect(calls[2]?.url).toBe("http://fire.test/_batch");
  await expect(pendingRead).resolves.toMatchObject({ ok: true });
});

test("MAX_BATCH_ITEMS flushes immediately and the next item starts a new window", async () => {
  const { calls, fetch } = captureFetch(okBatch);
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 10 },
    fetch,
  });

  const firstWindow = Array.from({ length: MAX_BATCH_ITEMS }, (_, index) =>
    client.posts.get(`p${index}`),
  );
  expect(calls).toHaveLength(1);
  expect((calls[0]!.body as { items: unknown[] }).items).toHaveLength(MAX_BATCH_ITEMS);

  const overflow = client.posts.get("overflow");
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.body).toEqual({
    kind: "batch",
    items: [{ kind: "collection", collection: "posts", operation: "get", id: "overflow" }],
  });
  await expect(Promise.all([...firstWindow, overflow])).resolves.toHaveLength(MAX_BATCH_ITEMS + 1);
});

test("in-flight batches are not mutated; later reads start a new window", async () => {
  const releases: Array<(response: Response) => void> = [];
  const { calls, fetch } = captureFetch(
    () =>
      new Promise<Response>((resolve) => {
        releases.push(resolve);
      }),
  );
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch,
  });

  const first = client.posts.get("p1");
  const second = client.posts.get("p2");
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toHaveLength(1);
  expect(releases).toHaveLength(1);

  const third = client.posts.get("p3");
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toHaveLength(2);
  expect((calls[0]!.body as { items: unknown[] }).items).toHaveLength(2);
  expect((calls[1]!.body as { items: unknown[] }).items).toHaveLength(1);

  releases[0]!(okBatch(calls[0]!));
  releases[1]!(okBatch(calls[1]!));
  await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
});

test("headers getter runs once per flush, not per enqueue", async () => {
  let headerReads = 0;
  const { fetch } = captureFetch(okBatch);
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    headers: () => {
      headerReads += 1;
      return { authorization: "Bearer token" };
    },
    fetch,
  });

  const reads = Promise.all([client.posts.get("p1"), client.posts.get("p2")]);
  expect(headerReads).toBe(0);
  await vi.advanceTimersByTimeAsync(0);
  await reads;
  expect(headerReads).toBe(1);
});

test("empty ids fail locally without enqueuing other reads", async () => {
  const { calls, fetch } = captureFetch(okBatch);
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch,
  });

  const empty = client.posts.get("");
  const pending = client.posts.get("p1");
  await expect(empty).resolves.toMatchObject({
    ok: false,
    error: { code: "VALIDATION", status: 400 },
  });
  expect(calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toHaveLength(1);
  await expect(pending).resolves.toMatchObject({ ok: true });
});

test("item operation failures resolve per Promise; transport errors reject all", async () => {
  const { fetch } = captureFetch(() =>
    Response.json({
      ok: true,
      data: [
        { ok: true, data: { id: "p1" } },
        {
          ok: false,
          error: {
            kind: "operation",
            code: "NOT_FOUND",
            message: "Not found",
            status: 404,
          },
        },
      ],
    }),
  );
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch,
  });
  const first = client.posts.get("p1");
  const second = client.posts.get("missing");
  await vi.advanceTimersByTimeAsync(0);
  await expect(first).resolves.toEqual({ ok: true, data: { id: "p1" } });
  await expect(second).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });

  const offline = captureFetch(() => Promise.reject(new Error("offline")));
  const rejecting = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch: offline.fetch,
  });
  const a = rejecting.posts.get("a");
  const b = rejecting.posts.get("b");
  const rejected = Promise.allSettled([a, b]);
  await vi.advanceTimersByTimeAsync(0);
  await expect(rejected).resolves.toEqual([
    { status: "rejected", reason: expect.objectContaining({ message: "offline" }) },
    { status: "rejected", reason: expect.objectContaining({ message: "offline" }) },
  ]);
});

test("top-level wire failure fans out as the same result; count mismatch rejects", async () => {
  const unauthorized = captureFetch(() =>
    Response.json(
      {
        ok: false,
        error: {
          kind: "operation",
          code: "UNAUTHORIZED",
          message: "Unauthorized",
          status: 401,
        },
      },
      { status: 401 },
    ),
  );
  const client = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch: unauthorized.fetch,
  });
  const first = client.posts.get("p1");
  const second = client.posts.get("p2");
  await vi.advanceTimersByTimeAsync(0);
  const [left, right] = await Promise.all([first, second]);
  expect(left).toEqual(right);
  expect(left).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED", status: 401 } });

  const mismatch = captureFetch(() =>
    Response.json({ ok: true, data: [{ ok: true, data: { id: "only-one" } }] }),
  );
  const mismatched = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch: mismatch.fetch,
  });
  const tooFewA = mismatched.posts.get("a");
  const tooFewB = mismatched.posts.get("b");
  const tooFew = Promise.allSettled([tooFewA, tooFewB]);
  await vi.advanceTimersByTimeAsync(0);
  const tooFewResults = await tooFew;
  expect(tooFewResults[0]).toMatchObject({ status: "rejected" });
  expect(tooFewResults[1]).toMatchObject({ status: "rejected" });
  expect((tooFewResults[0] as PromiseRejectedResult).reason).toEqual(
    (tooFewResults[1] as PromiseRejectedResult).reason,
  );
  expect((tooFewResults[0] as PromiseRejectedResult).reason).toMatchObject({
    message: expect.stringMatching(/Invalid batch response/i),
  });

  const invalidJson = captureFetch(() => new Response("not-json"));
  const broken = createClient<PostsCarrier>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch: invalidJson.fetch,
  });
  const jsonA = broken.posts.get("a");
  const jsonB = broken.posts.get("b");
  const jsonFailed = Promise.allSettled([jsonA, jsonB]);
  await vi.advanceTimersByTimeAsync(0);
  const jsonResults = await jsonFailed;
  expect(jsonResults[0]?.status).toBe("rejected");
  expect(jsonResults[1]?.status).toBe("rejected");
});

test("createClient rejects non-finite maxWaitMs", () => {
  const { fetch } = captureFetch(okSingle);
  for (const maxWaitMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expect(() =>
      createClient<PostsCarrier>("http://fire.test", {
        batch: { maxWaitMs },
        fetch,
      }),
    ).toThrow(TypeError);
  }
});

test("createClient rejects maxSize outside the protocol limit", () => {
  const { fetch } = captureFetch(okSingle);
  for (const maxSize of [0, 1.5, MAX_BATCH_ITEMS + 1, Number.NaN]) {
    expect(() =>
      createClient<PostsCarrier>("http://fire.test", {
        batch: { maxWaitMs: 0, maxSize },
        fetch,
      }),
    ).toThrow(TypeError);
  }
});
