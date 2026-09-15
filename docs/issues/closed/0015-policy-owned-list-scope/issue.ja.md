---
title: クライアント指定の問い合わせ条件から必須の list スコープを分離する
author: OpenAI Codex
cost: 5
priority: P0
priority_reason: "所有者スコープのポリシーを1つ誤るとコレクション全体が他ユーザーに露出し、Takibi にはサーバー強制の行スコープがない。"
category: security
source_issue: 0059-policy-owned-list-scope
status: closed
closed_reason: superseded
replacement: ../0018-policy-owned-list-range/issue.ja.md
---

[English](./issue.md)

# 状態

[0018-policy-owned-list-range](../0018-policy-owned-list-range/issue.ja.md)
に置き換えられ、終了しました。決定した契約は
[design-01.ja.md](../0018-policy-owned-list-range/design-01.ja.md)
にあります。この issue のコレクション級 `listScope` 提案は実装しないでください。

# 置き換えた理由

当初の記述は、サーバー所有の list スコープが無いことを P0 の迂回として扱っていました。
現行の list ポリシーは依然として `list` 権限を要求し、`queryImpliesEquality` は
`and` / `or` を保守的に歩き、`not` を拒否します。実証された認可迂回はありません。

残る問題は認可設計です。アプリケーションはクライアントフィルタが所有者制約などを含意することを証明しなければならず、コレクションに無条件の天井を別置きすると、所有者・管理者・公開レコードの grant を合成できません。これらの規則は独立した `listScope` コールバックではなく、ポリシー所有の list 範囲に置きます。

# 当時の問題

文書ポリシーは `doc` / `nextDoc` を受け取りますが、list ポリシーは文書を受け取りません。
所有者スコープの list が安全なのは、アプリケーションポリシーが任意のクライアント Boolean AST が
`ownerId = currentUser` を含意すると証明できる場合だけです。クライアントは画面ごとのフィルタでもその制約を繰り返す必要があります。grant のあと、worker-runtime は要求された問い合わせをそのまま実行します。

# 当時の提案（不採用）

コレクション定義に `listScope` を追加し、要求フィルタと AND し、結合した実効問い合わせにカーソルを結びます。`accessPolicy` は `list` の許可または拒否だけを行う想定でした。この天井は管理者例外と所有者規則を二重管理し、grant ごとの範囲を表現できません。
