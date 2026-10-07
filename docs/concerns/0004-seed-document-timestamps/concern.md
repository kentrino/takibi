---
title: seed のドキュメントにメタデータの時刻を指定できるようにするか
---

# Question

collection の `seed` は「ドキュメント ID → schema input」のレコードを返す。`seedCollections` は各エントリを `storageAdd(definition, driver, collection, data, { id })` で書き込む。このとき `createdAt` / `updatedAt` は渡さないので、両方とも投入した時刻になる。

一方で、時刻を指定する経路はすでにある。

- `prepareAddDoc` / `storageAdd` は `createdAt` / `updatedAt` を受け取れる。`trustedTimestamp` は、`toISOString()` の出力と完全に一致する正規の ISO 8601 表記だけを受け付ける。
- 公開型の `TrustedCollectionApi.add`（`$collection(s)`）の options には `createdAt` / `updatedAt` がある。README にこの options の説明はない。
- `seed` の型は `Omit<InferInput<TSchema>, ReservedDocumentDataKey>` である。そのため、データの中に `createdAt` を書くことは型でも実行時でも拒否される。

要望元のアプリは、一覧の「公開日」を独自の項目として持たず `createdAt` から導出している。seed で入れたデモデータの公開日が投入時刻になるので、「新しい順」の並びがデモで想定した日付と合わない。

README は `seed` を「production defaults」として説明している。seed は create-only で、Durable Object を再起動するたびに評価される。既存のドキュメントは上書きされない。

決めるべき境界は次の 3 点。

- seed という宣言的な初期データに、サーバー管理のメタデータを指定させるか。
- 指定させる場合、schema input と衝突しない形をどうするか。
- `createdAt` の意味（ドキュメントが保存された時刻）を、ドメイン上の日付の代わりに使う用途を支えるか。

# Related Files

- `packages/worker-runtime/src/durable-object.ts` — `seedCollections` が時刻を渡さずに `storageAdd` を呼ぶ
- `packages/worker-runtime/src/typed-storage.ts` — `prepareAddDoc` / `storageAdd` の `createdAt` / `updatedAt` と `trustedTimestamp`
- `packages/api/src/types.ts` — `seed` の型と、`TrustedCollectionApi.add` の options
- `packages/worker-runtime/src/testing-bridge.server.ts` — SQLite テスト backend の初期化でも `seedCollections` を呼ぶ
- `packages/takibi/README.md` — 「Collection seeds」節と、`createdAt` / `updatedAt` をサーバーが管理するという説明

# Options

## A. 現状維持

```ts
// seed は投入時刻のまま。日付を固定したいデモデータは信頼された経路から入れる
const seedDemo = app
  .defineAction()
  .policy(adminOnly)
  .handler(async ({ $collections }) => {
    await $collections.articles.add(
      { title: "秋の特集" },
      { id: "a1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
    );
  });
```

公開 API は変わらず、時刻を指定する経路は既存の `$collections.add` だけになる。デモデータを入れるには seed とは別の起動手順（action の呼び出しなど）が必要になる。`add` は create-only なので、2 回目の呼び出しは `ALREADY_EXISTS` になる。その扱いはアプリが決める。`TrustedCollectionApi.add` の時刻 options が README に書かれていない状態も続く。

## B. seed のエントリにメタデータを付けられるようにする

```ts
import { seedDocument } from "takibi";

seed: () => ({
  a1: seedDocument({ title: "秋の特集" }, { createdAt: "2026-09-01T00:00:00.000Z" }),
  a2: { title: "通常のエントリ" }, // 従来どおり投入時刻
}),
```

宣言的な seed のまま日付を固定できる。値を重複して持つ必要もない。schema input と見分けるには、ラッパー（専用の関数、symbol、`{ data, createdAt }` 形式など）が必要になる。`updatedAt` を省略したときの既定値（`createdAt` と同じか、投入時刻か）も決める必要がある。production の初期データにも過去の日付を指定できるので、`createdAt` が「保存された時刻」を表すとは限らなくなる。

## C. ドメイン上の日付を schema の項目として持つ

```ts
const Article = z.object({ title: z.string(), publishedAt: z.iso.datetime() });

seed: () => ({ a1: { title: "秋の特集", publishedAt: "2026-09-01T00:00:00.000Z" } }),
// indexes: { byPublishedAt: ["publishedAt"] }
// list({ index: "byPublishedAt", orderBy: (q) => q.publishedAt.desc() })
```

Takibi の変更は不要で、「公開日」と「保存日時」を別々に扱える。公開日を後から変える、予約公開するといった要件にも対応できる。新規作成のたびに、アプリが `publishedAt` を設定する必要がある。作成時点では値が `createdAt` と重なる。index は `createdAt` の代わりに `publishedAt` を含めて宣言する。
