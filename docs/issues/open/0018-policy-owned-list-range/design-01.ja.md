---
title: ポリシー所有の list / count 範囲
author: OpenAI Codex
status: accepted
issue: ./issue.ja.md
---

[English](./design-01.md)

これは
[0018-policy-owned-list-range](./issue.ja.md)
の受諾契約です。
[0015-policy-owned-list-scope](../../closed/0015-policy-owned-list-scope/issue.ja.md)
のコレクション級 `listScope` 提案を置き換えます。

# 決定

list と count の認可は、独立したコレクション天井ではなく **ポリシー所有の範囲** です。

grant の list 決定は次のいずれかちょうど1つです。

- `deny` — `list` 権限なし
- `allowAll` — 無制限の list（現行の `grant("list")`、`read`、`fullAccess`）
- `allowWhere(QueryExpr)` — サーバーが構築した問い合わせに合う行だけを list

所有者・管理者・公開レコードの規則は、既存の `and` / `or` で合成します。
`CollectionDefinition` に `listScope` を追加しません。

# 現行の振る舞い

`packages/worker-runtime/src/executor.ts` は、要求フィルタを `AccessContext.where`
に載せてコレクションポリシーを評価し、`executeResolvedCollection` はその同じ
`req.list` をストレージへ渡します。

`queryImpliesEquality` は保守的です。`and` はいずれかのオペランドが等値を含意すれば成功し、`or` はすべてのオペランドが含意するときだけ成功し、`not` は false を返します。実証された迂回はありません。代償として、アプリケーションは
`packages/takibi/docs/recipes/owner-scoped-collections.md`
のようにクライアントフィルタを証明しなければなりません。

`AccessGrant` は空のブランド付きオブジェクトです。権限と拒否理由は WeakMap
（`packages/policy/src/policy.ts`）に置かれます。`and` は権限を交差させ、集合が空なら
`none` を返します。`or` は権限を和集合し、すべての権限が揃えば `fullAccess`
シングルトンを返します。範囲がこれらの早期終了に加わらないと、合成で範囲が落ちます。

問い合わせの正規化（`packages/protocol/src/query.ts`）は検証して凍結します。平坦化も簡約もしません。上限は 32 ノード、深さ 8 です。Boolean 定数はありません。空の `and` / `or` は拒否されます。

list カーソル（`packages/storage/src/storage.ts`）は認証されない base64url JSON（v2/v3）です。完全な `where` を埋め込み、インデックス走査では末尾行のインデックスタプルも持ちます。等値判定は `JSON.stringify` です。実効問い合わせを `where` に代入すると、サーバー専用の述語が漏れます。

# 受諾 API

`grant(...permissions)` とカタログコールバックは残します。入力を、query が構築するスコープトークンで拡張します。

```ts
grant("get", listWhere((q) => q.ownerId.eq(user.id)));
grant("list"); // allowAll
```

`listWhere` は `@takibi/query` に置き、`compileWhere` にブランドを付けたものです。コールバックはビルダーが作った `QueryExpr` を返さなければならず、既存のクライアント上限 32/8 で正規化されます。トークン型は `@takibi/shared-types` に置き、`@takibi/policy` が `@takibi/query` に依存せず受け取れます。

```ts
type ListWhereScope = {
  readonly kind: "listWhere";
  readonly where: QueryExpr;
};
```

`grant(listWhere(...))` は `list` を `allowWhere` として与えます。同じ呼び出しの裸の `"list"` は `allowAll` です。`allowAll` AND `allowWhere(W)` は `allowWhere(W)` です。1つの `grant()` に `listWhere` が2つあれば AND します。

`read` と `fullAccess` は `allowAll` のままです。定数の `grant("get")` / `none` は list について `deny` のままです。スコープのない `grant("list")` は無制限のままです。

`grant.list.allowAll()` や JS から SQL への汎用コンパイラは作りません。フィールド型は `QueryBuilder<TDoc>` を使います。型テストは未知フィールドを拒否しなければなりません。`TDoc` はコレクションスキーマから束縛します（スキーマ束縛のヘルパー別名は許可します）。

ランタイム向けに `listDecisionOf(grant)` を `@takibi/policy` から公開します。決定は権限の横の WeakMap に保存します。

# 合成

権限は list 範囲から独立したままです。`update` は与えるが `list` は与えない枝は、他枝の list 範囲を広げも狭めもしません。

list 決定の概念演算:

| 左 \ 右 | `deny` | `allowAll` | `allowWhere(W2)` |
| --- | --- | --- | --- |
| `deny` | `deny` | `deny`（and）/ `allowAll`（or） | `deny`（and）/ `allowWhere(W2)`（or） |
| `allowAll` | `deny`（and）/ `allowAll`（or） | `allowAll` | `allowWhere(W2)`（and）/ `allowAll`（or） |
| `allowWhere(W1)` | `deny`（and）/ `allowWhere(W1)`（or） | `allowWhere(W1)`（and）/ `allowAll`（or） | `allowWhere(and(W1,W2))` / `allowWhere(or(W1,W2))` |

`and` は全権限と `allowAll` から始め、各枝（list 決定を含む）を交差させ、権限が残らなければ従来どおり `none` を返します。

`or` は権限なしと `deny` から始め、和集合します。`list` を与える枝だけが範囲を寄与します。`or` が `fullAccess` シングルトンを返してよいのは、すべての権限があり **かつ** list 決定が `allowAll` のときだけです。全権限でも `allowWhere` なら `fullAccess` にインターンしてはなりません。

`composedGrant` も同じインターン規則に従います。拒否理由は変更しません。

# ランタイム

list/count ごとに認可と範囲を一度だけ評価します。

1. クライアント `where` を既存の 32/8 上限で正規化する。これが **要求** 問い合わせです。`AccessContext.where` に残します。
2. 今日どおり `accessPolicy` を評価する（`packages/worker-runtime/src/invocation-collaborators.ts`）。
3. ポリシー拒否は `FORBIDDEN` のままです。`list` のない grant は拒否です。
4. grant から list 決定を取り出す。`undefined` を `allowAll` にしてはなりません。
5. **実効** 問い合わせを作る。
   - `allowAll` → 要求（欠けることもある）
   - `allowWhere(S)` かつ要求なし → `S`
   - `allowWhere(S)` かつ要求 `W` → `composeAnd(S, W)`
6. インデックス計画・ページネーション・count の **前に** 実効問い合わせをストレージへ渡す。公開 HTTP とポリシー拘束のアクションファサード（`createPolicyCollections`）はこの経路を共有する。
7. 信頼された `$collections` はポリシーと範囲を迂回する。実効問い合わせは要求問い合わせである。

`AccessContext.where` を実効問い合わせで上書きしない。watch はここでは実装しない。
[0007-realtime-query-watch](../0007-realtime-query-watch/issue.md)
は、後でこの同じ評価と合成の経路を呼ばなければなりません。

# 失敗閉鎖の範囲結果

`listWhere` と合成は、欠けた値を無制限として扱ってはなりません。

- コールバックが関数でない、例外を投げる、ビルダー以外の値を返す → 失敗閉鎖
- 空または不正な AST（空の `and` / `or` を含む） → 失敗閉鎖
- 合成の上限超過 → 失敗閉鎖

これらは、文書値も生の範囲 AST もクライアントメッセージに出さない安全なサーバーエラーとして表面化します。`FORBIDDEN` でも `undefined` でもありません。

# 実効問い合わせの合成と容量

`@takibi/query` は、すでに正規化された `QueryExpr` 木に対する `composeAnd` / `composeOr` を所有します。平坦化も簡約も Boolean 定数の導入もしません。オペランドが1つならそのオペランドを返し、2つ以上なら既存形の単一 `and` / `or` ノードで包みます（オペランドは少なくとも2つ）。

クライアント取り込みは 32 ノード / 深さ 8 のままです。各 `listWhere` 結果も同じ予算を使います。サーバー範囲があるからといってクライアント上限を上げません。

合成された **ポリシー** 範囲と `and(scope, requested)` は、別のサーバー予算を使います。**64 ノード / 深さ 16** で、既存定数の隣に `@takibi/protocol` が所有します。超過は失敗閉鎖です。これはクライアント緩和ではなく、存在しない簡約に依存してはなりません。

# カーソル

カーソルは `@takibi/storage` に残します。protocol へ移しません。

**list カーソル v4** を導入します。出荷後は v2 と v3 を拒否します（古いトークンは `where` を埋め込み、binding がありません）。

```ts
type ListCursorV4 = {
  v: 4;
  collection: string;
  requestedWhere: QueryExpr | null;
  binding: string; // base64url(SHA-256(utf8(JSON.stringify(effectiveWhere ?? null))))
  id: string;
  // インデックス時のみ:
  index?: string;
  fields?: readonly string[];
  orderField?: string;
  direction?: "asc" | "desc";
  values?: readonly (string | number)[];
};
```

`StorageListOptions.where` は、計画と実行に使う **実効** 問い合わせになります。カーソル互換のために `requestedWhere` を追加します（信頼経路では `where` が既定です）。

継続のたびに **再認可** します。そのうえで次を要求します。

- `cursor.requestedWhere` が、この要求の要求問い合わせと等しい
- `cursor.binding` が、この要求の実効問い合わせのダイジェストと等しい
- コレクション / インデックス / 順序フィールドが一致する（v3 と同じ）

実効問い合わせの互換は **同一性の束縛ではありません**。同じ実効 AST に合成される別プリンシパルはカーソルを再利用できます。トークンにユーザー id、`tenantId`、その他の予約コンテキストキーを入れません。

## 保証（率直に）

binding は、正規化済み AST の正規形（凍結木の `JSON.stringify`。正規化は並べ替えないのでオペランド順は意味を持つ）に対する **鍵なし SHA-256 ダイジェスト** です。プラットフォームの Web Crypto（`crypto.subtle`）を使います。

- **互換:** 継続が走るのは、この要求で新たに合成した実効問い合わせがダイジェストと一致するときだけです。
- **秘密ではない:** 同じ AST を組み立てられる者はダイジェストを計算できます。ハッシュを機密として文書化しないでください。
- **認証されない:** クライアントは `binding`、`id`、`values` を偽造できます。*別* 範囲向けのダイジェスト偽造は、再認可後の互換検査で失敗します。*現在* の範囲で `id` / `values` を偽造すると、**認可済み集合の内側** でページを飛ばしたり並べ替えたりできます。これは符号なし v2/v3 カーソルと同じ種類です。カーソルは認可資格情報ではありません。
- **サーバー述語の機密性:** v4 は実効 AST を省略するので、デコーダはサーバー専用の葉を見ません。それは **暗号化ではなく省略** です。インデックスの `values` は、最後に返した行のインデックスタプルを依然として露出します。そこには、そのページに既にある所有者フィールドが含まれることがあります。インデックスカーソルが認可データを隠すとは主張しないでください。

# インデックス、count、テスト

`planIndexRange` と SQL コンパイルは実効問い合わせを消費し、範囲の等値をインデックス接頭辞にできます。count は、ページをまたいで list と同じ実効集合を使います。

list、count、インデックス、カーソル v4、セキュリティテストを **1つの実装単位** として出荷します。最初の着陆をパッケージごと、または `list` 対 `count` で分割しないでください。

所有者スコープのレシピと README を更新し、メンバー list はクライアントフィルタ上の `queryImpliesEquality` を要求するのではなく `listWhere` を使うようにします。`queryImpliesEquality` は任意のアプリケーション証明であり、list の機構ではないと文書化します。

# パッケージ境界

| パッケージ | 所有 |
| --- | --- |
| `@takibi/policy` | grant の list 決定意味論、WeakMap 保存、`and` / `or` の終了、`listDecisionOf` |
| `@takibi/query` | `listWhere`、`composeAnd` / `composeOr` |
| `@takibi/protocol` | AST 形、クライアント 32/8 上限、サーバー合成 64/16 上限 |
| `@takibi/shared-types` | `ListWhereScope`。`StorageListOptions` の任意の `requestedWhere` |
| `@takibi/worker-runtime` | 一度きりの評価、要求対実効、公開およびアクションファサード |
| `@takibi/storage` | 実効問い合わせ実行、インデックス計画、カーソル v4 |
| `@takibi/api` / `takibi` | 再エクスポートとコレクション型。新しい `listScope` フィールドは置かない |

新しいパッケージは作りません。policy は query に依存しません。カーソル符号化は storage に残します。

# 対象外

- `get` / 書き込み向けの宣言的述語。新旧文書の可視性は不変の所有者強制ではなく、後続の設計です。
- コレクション級 `listScope`。
- カーソルの protocol への移動、またはダイジェストを秘密として扱うこと。
- watch の実装、予約コンテキスト同一性、JS から SQL への汎用コンパイラ。
- 信頼された `$collections` への範囲適用。
- クライアント問い合わせ上限の引き上げ、または木の暗黙の平坦化。
