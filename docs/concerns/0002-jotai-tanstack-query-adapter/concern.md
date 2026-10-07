---
title: Jotai / TanStack Query 向けの Result adapter を Takibi が提供するか
---

# Question

公開クライアントの CRUD と action は `Promise<TakibiResult<T>>` を返し、サーバーが判断した failure では reject しない（RFC 0008）。TanStack Query は失敗を reject で判定するため、利用側では Result を例外に戻す層が必要になる。

要望元のアプリ（yr-clinic）は、次の層を `apps/web/src/takibi/` に置いている。要望者は、別アプリにもこれをほぼそのまま複製したと報告している。

- `unwrapTakibi(result)` は `ok: false` のとき `TakibiFailureError` を投げる。
- `TakibiFailureError` は failure を保持し、表示用の message を組み立てる。その際、アプリ固有の `reasonDisplayMessages`（`reason.code` から表示文言への対応表）と `messageForTakibiError`（`STALE_WRITE` などの文言）を参照する。
- `atomWithTakibiQuery` / `atomWithTakibiMutation` は `jotai-tanstack-query` の `atomWithQuery` / `atomWithMutation` を包み、`queryFn` / `mutationFn` の Result を unwrap する。mutation では `invalidate` の query key も無効化する。
- `combineTakibi` は複数の Result を待ち、1 つの Result にまとめる。

Takibi 側の現状は次のとおり。

- UI 統合は提供していない。README の「Types and UI ownership」は、UI 側の状態の射影をアプリの責務として説明している。
- `takibi` パッケージには `dependencies` も `peerDependencies` もない。周辺ライブラリとの統合は `@takibi/hono-adapter` や `@takibi/better-auth-adapter` のように別パッケージにし、対象ライブラリを peer dependency にしている。
- `reason.code` の localize はクライアントの責務とされている（README「Public policy denial reasons」）。

決めるべき境界は次の 4 点。

- Takibi が UI 状態ライブラリとの統合を持つか。
- 持つ場合、どの層まで持つか（Result を例外にする変換だけか、atom まで含めるか）。
- どこに置くか（`takibi` の subpath か別パッケージか）。
- 表示用 message の差し込み口をどの形にするか。

# Related Files

- `packages/takibi/package.json` — 公開 subpath（`.`, `./client`, `./watch`, `./testing`, `./instrumentation`）。依存は宣言していない
- `packages/takibi/src/client-entry.ts` — `takibi/client` の公開面
- `packages/client/src/client-types.ts` — クライアントメソッドの戻り値型
- `packages/shared-types/src/index.ts` — `TakibiResult` / `TakibiFailure` / `PolicyReason`
- `packages/hono-adapter/package.json` — 周辺ライブラリを peer dependency にした別パッケージの前例
- `packages/better-auth-adapter/package.json` — 同上
- `packages/takibi/README.md` — 「Client」「Public policy denial reasons」「Types and UI ownership」節
- `docs/rfcs/0008-server-throws-client-results.md` — クライアント境界で Result を返すという決定

# Options

## A. 現状維持（アプリが持つ）

```ts
// app: src/takibi/query.ts（アプリごとに保持）
export const postsAtom = atomWithTakibiQuery(() => ({
  queryKey: ["posts"],
  queryFn: () => client.posts.list(),
}));
```

Takibi は jotai と TanStack Query の版に追従しなくてよく、公開面も増えない。アプリごとに同じ実装を持つことになり、Takibi の failure 型が変わったときは各アプリが追従する。message の組み立て方はアプリが自由に決められる。

## B. フレームワーク非依存の変換だけを `takibi/client` で提供する

```ts
import { unwrapTakibi, TakibiFailureError } from "takibi/client";

// app: atom はアプリに残し、message は表示側で決める
const postsAtom = atomWithQuery(() => ({
  queryKey: ["posts"],
  queryFn: async () => unwrapTakibi(await client.posts.list()),
}));
const message = (e: unknown) =>
  e instanceof TakibiFailureError ? displayMessage(e.failure) : "Unexpected error";
```

追加の依存は生まれず、TanStack Query 以外（SWR、React 19 の `use` など）でも使える。`TakibiFailureError` の `message` はサーバーの message のままにし、表示用の文言はアプリが `failure` から組み立てる。atom 層と `invalidate` の配線はアプリに残る。

## C. `takibi/jotai` subpath で atom まで提供する

```ts
import { createTakibiAtoms } from "takibi/jotai";

export const { atomWithTakibiQuery, atomWithTakibiMutation } = createTakibiAtoms({
  messageFor: (failure) =>
    (failure.kind === "operation" && reasonDisplayMessages[failure.reason?.code ?? ""]) ||
    failure.message,
});
```

利用側は `import` 1 行と差し込み口の設定だけで済み、要望どおりの API になる。`takibi` パッケージに初めて optional な peer dependency（`jotai`、`jotai-tanstack-query`、`@tanstack/query-core`）が入り、パッケージ単位で対象ライブラリの版に追従することになる。`jotai-tanstack-query` の型（`AtomWithQueryOptions` など）が Takibi の公開型に現れる。

## D. 別パッケージ `@takibi/jotai` で提供する

```ts
import { createTakibiAtoms } from "@takibi/jotai";

export const { atomWithTakibiQuery, atomWithTakibiMutation } = createTakibiAtoms({ messageFor });
```

C と同じ API を、hono-adapter / better-auth-adapter と同じ配置で提供する。`takibi` 本体の依存は増えず、対象ライブラリの版はこのパッケージだけで追従できる。ビルド・公開・リリースの対象が 1 つ増える。`unwrapTakibi` 相当をこのパッケージだけに置くか、B のように `takibi/client` にも置くかを別に決める必要がある。
