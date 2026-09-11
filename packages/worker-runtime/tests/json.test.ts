import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { fullAccess } from "@takibi/policy";
import { prepareAddDoc } from "@takibi/worker-runtime";

test("schema outputs that are not plain JSON documents fail before storage", async () => {
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => "hidden behavior",
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const withSymbol = { title: "symbol" };
  Object.defineProperty(withSymbol, Symbol("hidden"), {
    enumerable: true,
    value: "not JSON",
  });
  const sparse = Array.from({ length: 2 });
  sparse[0] = "first";

  const invalidOutputs = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    Symbol("value"),
    new Date(),
    accessor,
    cyclic,
    withSymbol,
    { nested: new Date() },
    { nested: sparse },
    ["root array"],
    null,
    "root scalar",
  ];

  for (const output of invalidOutputs) {
    const definition = {
      schema: z.unknown().transform(() => output),
      accessPolicy: fullAccess,
    };
    await expect(prepareAddDoc(definition, {})).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      status: 500,
    });
  }
});

test("plain nested JSON schema outputs remain valid documents", async () => {
  const definition = {
    schema: z.object({
      nested: z.object({
        values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
      }),
      optional: z.string().optional(),
    }),
    accessPolicy: fullAccess,
  };

  await expect(
    prepareAddDoc(definition, { nested: { values: ["text", 42, true, null] } }, { id: "valid" }),
  ).resolves.toMatchObject({
    id: "valid",
    nested: { values: ["text", 42, true, null] },
  });
});
