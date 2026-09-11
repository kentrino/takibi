import { expectTypeOf, test } from "vite-plus/test";
import type {
  DistributiveOmit,
  ForbidKeys,
  HasDuplicateTupleMember,
  IsAny,
  KeysMatching,
  StringKeysMatching,
} from "@takibi/api";

declare const token: unique symbol;

test("KeysMatching extracts assignable value keys", () => {
  type Fields = {
    text: string;
    textLiteral: "draft";
    count: number;
    countLiteral: 1;
    mixed: string | number;
    optional?: string;
    nullable: string | null;
    unknown: unknown;
    anything: any;
    impossible: never;
    enabled: boolean;
  };

  expectTypeOf<KeysMatching<Fields, string>>().toEqualTypeOf<"text" | "textLiteral">();
  expectTypeOf<KeysMatching<Fields, number>>().toEqualTypeOf<"count" | "countLiteral">();
  expectTypeOf<KeysMatching<Fields, string | number>>().toEqualTypeOf<
    "text" | "textLiteral" | "count" | "countLiteral" | "mixed"
  >();
});

test("KeysMatching preserves non-string property keys", () => {
  type Fields = {
    0: string;
    [token]: string;
    label: number;
  };

  expectTypeOf<KeysMatching<Fields, string>>().toEqualTypeOf<0 | typeof token>();
  expectTypeOf<StringKeysMatching<Fields, string>>().toEqualTypeOf<never>();
});

test("IsAny distinguishes any from other broad types", () => {
  expectTypeOf<IsAny<any>>().toEqualTypeOf<true>();
  expectTypeOf<IsAny<unknown>>().toEqualTypeOf<false>();
  expectTypeOf<IsAny<never>>().toEqualTypeOf<false>();
});

test("HasDuplicateTupleMember detects repeated tuple members", () => {
  expectTypeOf<HasDuplicateTupleMember<readonly ["ownerId", "createdAt"]>>().toEqualTypeOf<false>();
  expectTypeOf<HasDuplicateTupleMember<readonly ["ownerId", "ownerId"]>>().toEqualTypeOf<true>();
});

test("DistributiveOmit preserves union members", () => {
  type Input =
    | { kind: "text"; value: string; metadata: string }
    | { kind: "count"; value: number; metadata: string };

  expectTypeOf<DistributiveOmit<Input, "metadata">>().toEqualTypeOf<
    { kind: "text"; value: string } | { kind: "count"; value: number }
  >();
});

test("ForbidKeys rejects only keys present in the object", () => {
  expectTypeOf<ForbidKeys<{ id: string; title: string }, "id" | "createdAt">>().toEqualTypeOf<{
    id?: never;
  }>();
  expectTypeOf<ForbidKeys<{ title: string }, "id">>().toEqualTypeOf<unknown>();
});
