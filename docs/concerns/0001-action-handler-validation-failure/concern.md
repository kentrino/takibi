---
title: action handler から構造化された validation failure を返す手段
---

# Question

action の入力は `.input(schema)` で検証され、失敗すると `{ kind: "validation", code: "VALIDATION", issues }` としてクライアントに届く。一方、handler 内で行う検証には、`validation` failure として投げる公開手段がない。

- `toTakibiFailure` が `kind: "validation"` に変換するのは `SchemaValidationError` だけで、それ以外の `TakibiError` は `code` に関係なく `kind: "operation"` になる。`new TakibiError("VALIDATION", messages.join("\n"), 400)` は issues を持たない operation failure として届く。
- `SchemaValidationError` は `@takibi/worker-runtime` と `packages/takibi/src/schema.ts` にあるが、公開エントリの `takibi` からは export されていない。
- handler 内で `collection.add` などが schema 検証に失敗すると、その `SchemaValidationError` はすでに `kind: "validation"` として届く。このときの `path` は action 入力ではなく、書き込み先 collection のドキュメントを基準にしている。今も `validation` failure の `path` が何を基準にするかは一つに決まっていない。
- `.input()` のスキーマは handler の前に評価され、`collections` を参照できない。保存済みデータに依存する検証は入力スキーマに書けない。

要望元のアプリ（yr-clinic）は handler 内で `validateDraft` を実行し、その結果を `TakibiError("VALIDATION", …)` として投げている。そのため、どのフォーム欄のエラーかという情報がクライアントで失われる。

決めるべき境界は次の 3 点。

- handler が `validation` failure を作れる公開 API を設けるか。
- 設けるなら、どのパッケージの型として、どの issue 型（Standard Schema の `Issue` か、wire 用の `ValidationIssue` か）で受けるか。
- `kind` の判別子と wire 契約（`isWireResponse` の検査、`TakibiFailure` の union）をどこまで変えるか。

# Related Files

- `packages/worker-runtime/src/result.ts` — `toTakibiFailure` が `SchemaValidationError` だけを `validation` に変換する
- `packages/worker-runtime/src/schema.ts` — `SchemaValidationError` の定義
- `packages/worker-runtime/src/context/runtime.ts` — 実行境界で failure を正規化する `normalizeInvocationFailureForServer` とステータスを決める `statusOf`
- `packages/worker-runtime/src/action-resolution.ts` — `.input()` スキーマを handler の前に評価する
- `packages/api/src/errors.ts` — 公開エラークラス群（`TakibiError` とそのサブクラス）
- `packages/takibi/src/index.ts` — 公開エントリ。`SchemaValidationError` は export していない
- `packages/takibi/src/schema.ts` — `SchemaValidationError` の内部再 export
- `packages/shared-types/src/index.ts` — `TakibiValidationFailure` / `TakibiOperationFailure` / `ValidationIssue`
- `packages/protocol/src/wire.ts` — 応答 envelope の検査。`validation` は `code: "VALIDATION"`、`status: 400`、`issues` 配列を必須にする
- `packages/takibi/README.md` — Actions 節で「入力の失敗は validation、handler の失敗は `TakibiError` サブクラス」と説明している
- `docs/rfcs/0008-server-throws-client-results.md` — サーバー内では throw、クライアント境界では Result を返すという決定

# Options

## A. 現状維持

```ts
const submit = app
  .defineAction()
  .input(DraftInput.superRefine(checkShape)) // 保存済みデータに依存しない検証はここに書く
  .policy(staffPolicy)
  .handler(async ({ input, collections }) => {
    const messages = await validateDraft(input, collections);
    if (messages.length > 0) throw new BadRequestError(messages.join("\n"));
    // ...
  });

// client
if (!result.ok && result.error.kind === "operation") showToast(result.error.message);
```

公開 API と wire 契約は変わらない。保存済みデータに依存しない検証は `.input()` の refinement で `issues` 付きにできる。保存済みデータに依存する検証は文字列 1 つになり、欄ごとの表示にはアプリ独自の符号化（message の書式や独自 `code`）が要る。

## B. `validation` failure になる公開エラークラスを追加する

```ts
import { TakibiValidationError } from "takibi";

.handler(async ({ input, collections }) => {
  const issues = await validateDraft(input, collections); // { message, path? }[]
  if (issues.length > 0) throw new TakibiValidationError(issues);
});

// client: 入力スキーマの失敗と同じ分岐で扱える
if (!result.ok && result.error.kind === "validation") {
  for (const issue of result.error.issues) form.setError(issue.path?.join("."), issue.message);
}
```

クライアント側の型と wire 契約は変わらず、既存の `validation` 分岐をそのまま使える。決めることとして、クラスを `@takibi/api` に置くか（`TakibiError` のサブクラスにするか）、既存の `SchemaValidationError` を公開するか、受け取る issue の型をどうするかがある。`path` の基準が action 入力・collection ドキュメント・アプリ定義の 3 通りに増え、クライアントは `kind` だけでは基準を区別できない。

## C. operation failure に任意の `issues` を持たせる

```ts
.handler(async ({ input, collections }) => {
  const issues = await validateDraft(input, collections);
  if (issues.length > 0) throw new BadRequestError("Draft is invalid", { issues });
});

// client
if (!result.ok && result.error.kind === "operation" && result.error.issues) {
  showFieldErrors(result.error.issues);
}
```

`kind: "validation"` の意味（スキーマ検証の失敗）を保ったまま、アプリ定義の `code` と欄ごとの情報を両方返せる。`TakibiOperationFailure` の型、`isWireResponse` の検査、watch の failure キー検査（`packages/protocol/src/watch.ts`）を変える必要がある。クライアントは欄ごとのエラーを `validation` と `operation` の 2 か所で扱うことになる。
