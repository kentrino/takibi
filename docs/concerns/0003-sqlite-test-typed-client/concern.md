---
title: SQLite テストハンドラから利用者ごとの typed client を得る手段
---

# Question

`withSqliteTestBackend(handler, options)` が返すハンドラは `handle(request, { context })` と `DurableObject` を持つ。typed client を作る経路と、テストで利用者を切り替える経路は、どちらも利用側が組み立てている。

- `createClient` の `fetch` に渡す「`Request` を作り、`handle` を呼び、`matched` を確かめて `Response` を返す」関数は Takibi が提供していない。リポジトリ内でも `requestTakibi` が 5 パッケージの `tests/helpers/request.ts` に重複している。要望元のアプリにも同じ処理の `sqliteTestFetch` がある。
- README の「Node integration tests」は `fetch: handler.request` と書いている。しかし、`TestingForkHandler` が公開するのは `handle` / `DurableObject` / `Symbol.dispose` だけで、`request` はない。
- 利用者の切り替えでは、production の resolver を `resolve` で差し替え、`x-test-user` ヘッダーに入れた JSON を読み戻す方式が README、`packages/takibi/tests`、要望元アプリで繰り返されている。
- `withSqliteTestBackend` は呼ぶたびに独立した SQLite データベースを作る。同じデータに対して利用者を変えるには、1 つのハンドラの中で利用者ごとに context を変える必要がある。
- `resolve` を差し替えても、`handle` の入力 context は production の型のまま必須になる。そのため、Durable Object namespace などのダミーを用意しなければならない。この点は [issue 0021](../../issues/open/0021-sqlite-test-context-input/issue.md) が扱うので、この concern では扱わない。

決めるべき境界は次の 3 点。

- testing entry が typed client の生成まで受け持つか。
- 受け持つ場合、利用者ごとの context を resolver の入力（initial context）として渡すか、解決済みの context として渡して resolver を通さないか。
- production の resolver を通らない経路をテスト用 API として公開してよいか。

# Related Files

- `packages/testing/src/testing.server.ts` — `withSqliteTestBackend` と `SqliteTestBackendOptions`
- `packages/worker-runtime/src/testing-bridge.server.ts` — `TestingForkHandler` の公開面（`handle` / `DurableObject` / `Disposable`）
- `packages/worker-runtime/src/context/application.ts` — fork ごとに `mount` し、backend（データベース）を 1 つ作る
- `packages/worker-runtime/src/context/http-handler.ts` — `handle` と `matched`
- `packages/takibi/src/testing.server.ts` — `takibi/testing` の再 export
- `packages/takibi/README.md` — 「Node integration tests」節。`handler.request` と `x-test-user` の例
- `packages/takibi/tests/helpers/request.ts` — 重複している `requestTakibi` の一つ
- `packages/takibi/tests/takibi.test.ts` — `x-test-user` ヘッダーで利用者を切り替えるテスト
- `examples/realtime-chat/tests/chat.test.ts` — `handle` を包む `fetch` と、ダミーの env
- `docs/issues/open/0021-sqlite-test-context-input/issue.md` — 差し替えた resolver の入力型を扱う既存 issue

# Options

## A. 現状維持

```ts
const handler = withSqliteTestBackend(production, {
  resolve: ({ request }) => ({
    tenantId: "t",
    user: JSON.parse(request.headers.get("x-test-user")!),
  }),
});
const clientAs = (user: User) =>
  createClient<typeof handler>("https://app.test", {
    headers: { "x-test-user": JSON.stringify(user) },
    fetch: sqliteTestFetch(handler), // アプリが持つ
  });
```

公開面は増えない。リクエストからヘッダーを読む resolver を各アプリが書く。その過程で、context をシリアライズして復元する処理がテストの前提に入る。README の `handler.request` は実装と一致していない。

## B. `fetch` 互換の関数だけを提供する

```ts
const handler = withSqliteTestBackend(production, { resolve: resolveFromTestHeader });
const client = createClient<typeof handler>("https://app.test", {
  headers: { "x-test-user": JSON.stringify(user) },
  fetch: handler.fetch, // または takibi/testing の testFetch(handler)
});
```

`requestTakibi` / `sqliteTestFetch` の重複がなくなり、README の記述とも一致させられる。利用者の切り替えは、引き続きアプリが resolver とヘッダーで行う。`fetch` が `handle` に渡す initial context をどう決めるかは issue 0021 の結果に依存する。

## C. 解決済み context を渡して typed client を得る

```ts
using backend = withSqliteTestBackend(production);
const admin = backend.clientAs({ tenantId: "t", user: { id: "u1", role: "admin" } });
const member = backend.clientAs({ tenantId: "t", user: { id: "u2", role: "member" } });
// admin と member は同じデータベースを共有する
```

各 feature テストで resolver とヘッダーの準備が不要になる。`clientAs` の引数は production の resolved context 型で型付けできる。production の `resolve` を通らないため、resolver 自体の検証は別のテストで行う必要がある。同じ backend の中でリクエストごとに resolved context を差し込む経路が必要で、現在の fork（1 回の `mount` につき resolver が 1 つ）とは別の仕組みになる。差し込んだ context にも `assertSerializableContext` の検査を適用するかは別に決める必要がある。

## D. initial context を渡して typed client を得る（resolver は通す）

```ts
using backend = withSqliteTestBackend(production, {
  resolve: ({ context }) => ({ tenantId: "t", user: context.user }),
});
const member = backend.client({ user: { id: "u2", role: "member" } });
```

resolver を通したまま、ヘッダーへの符号化をやめられる。`client` の引数の型は resolver の入力型で決まるので、issue 0021 で入力型を差し替えられるようになることが前提になる。C と比べると、テストごとに resolver を 1 つ書く手間が残る。
