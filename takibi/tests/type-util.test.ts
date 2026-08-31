import { expectTypeOf, test } from "vite-plus/test";
import type { KeysMatching } from "../src/type-util";

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
});
