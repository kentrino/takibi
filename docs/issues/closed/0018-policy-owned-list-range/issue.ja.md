---
title: ポリシー所有の問い合わせ範囲で list と count を認可する
author: OpenAI Codex
cost: 5
priority: P1
priority_reason: "list 認可は、クライアントフィルタが所有者制約を含意することをアプリケーションに証明させている。これは設計上の隙間であり、実証された迂回ではない。"
category: security
source_issue: 0059-policy-owned-list-scope
supersedes: 0015-policy-owned-list-scope
status: closed
closed_reason: implemented
---

[English](./issue.md)

# 解決

ポリシー所有の list/count 範囲を実装しました。人が承認した policy → query
依存と合成・生成元の契約は [design-01.ja.md](./design-01.ja.md) に反映済みです。
ランタイムは一度だけ評価し、要求条件と実効条件を分離します。ストレージは計画・
ページネーションの前に実効範囲を適用し、サーバー AST を含めない、問い合わせに
結び付いたカーソル v4 を発行します。

検証: `pnpm run ready` 成功（整形・lint・型検査、Workers を含む再帰テスト、
再帰ビルド）。grant の代数、即時の上限超過、クエリ上限・生成元、公開 HTTP と
アクション、複数ページの count、信頼済み経路の迂回、SQLite のインデックス有無、
カーソル互換性・改ざんを検証しました。旧 v2/v3 カーソルは意図どおり拒否します。

# 問題

ポリシー拘束の `list` と `count` は権限を grant したあと、クライアントが要求した
`where` を実行します。所有者・管理者・公開レコードの範囲が欲しいアプリケーションは、
クライアントフィルタがそれらの制約を含意することを証明しなければなりません。
これは認可設計の隙間（P1）であり、実証された P0 迂回ではありません。

# 到達結果

[design-01.ja.md](./design-01.ja.md) の受諾契約を実装します。grant は
`deny` / `allowAll` / `allowWhere(QueryExpr)` の list 決定を持ち、ランタイムは操作ごとに実効問い合わせを一度合成し、ストレージはその問い合わせを実行し、サーバースコープをトークンに入れずにカーソルを結びます。

[0015-policy-owned-list-scope](../0015-policy-owned-list-scope/issue.ja.md)
を置き換えます。
[0007-realtime-query-watch](../../open/0007-realtime-query-watch/issue.md)
の将来の watch はこの経路を再利用し、本 issue の対象ではありません。

# 関連ファイル

- `packages/policy/src/policy.ts`
- `packages/policy/src/types.ts`
- `packages/api/src/types.ts`
- `packages/api/src/action.ts`
- `packages/query/src/query.ts`
- `packages/protocol/src/query.ts`
- `packages/worker-runtime/src/executor.ts`
- `packages/worker-runtime/src/invocation-collaborators.ts`
- `packages/worker-runtime/src/context/types.ts`
- `packages/storage/src/storage.ts`
- `packages/storage/src/indexes.ts`
- `packages/takibi/docs/recipes/owner-scoped-collections.md`
- `packages/takibi/README.md`
