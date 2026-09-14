import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { SchemaParser, parseSchema, type SchemaSurface } from "../src/schema";

test("schema surface and tracing preserve transformed output types", async () => {
  const schema = z.string().transform((value) => value.length);
  const parser: SchemaSurface = new SchemaParser();
  const parsed = parser.parse(schema, "hello");
  const traced = parseSchema(schema, "hello");
  expectTypeOf(parsed).toEqualTypeOf<Promise<number>>();
  expectTypeOf(traced).toEqualTypeOf<Promise<number>>();
  expect(await parsed).toBe(5);
  expect(await traced).toBe(5);
});
