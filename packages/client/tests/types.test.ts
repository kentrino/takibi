import { expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import type { TakibiDefinition } from "@takibi/api";
import type { PolicyReasonCodeCarrier } from "@takibi/policy";
import type { TakibiResult } from "@takibi/shared-types";
import { createClient, type ClientOf, type InferHandlerCollections } from "@takibi/client";

test("action output and policy reason-code inference reach ClientOf on a structural carrier", () => {
  const inputSchema = z.string().transform((value) => value.length);
  type StructuralHandler = TakibiDefinition<
    { readonly posts: { readonly schema: z.ZodObject<{ title: z.ZodString }> } },
    {
      readonly $: {
        readonly inspect: {
          readonly inputSchema: typeof inputSchema;
          readonly handler: (args: { input: number }) => Promise<{ positive: boolean }>;
        };
      };
      readonly posts: {
        readonly touch: {
          readonly target: "document";
          readonly inputSchema: undefined;
          readonly handler: (args: { id: string }) => Promise<{ touched: true }>;
        };
      };
    }
  >;

  type StructuralClient = ClientOf<StructuralHandler>;
  expectTypeOf<StructuralClient["inspect"]>().toEqualTypeOf<
    (input: string) => Promise<TakibiResult<{ positive: boolean }>>
  >();
  expectTypeOf<StructuralClient["posts"]["touch"]>().toEqualTypeOf<
    (id: string) => Promise<TakibiResult<{ touched: true }>>
  >();
});

test("ClientOf projects optional, required, and no-input action signatures", () => {
  const required = z.object({ title: z.string() });
  const optional = z.object({ note: z.string() }).optional();
  type Carrier = {
    readonly "~takibi": {
      readonly collections: { readonly posts: { readonly schema: typeof required } };
      readonly actions: {
        readonly $: {
          readonly required: {
            readonly inputSchema: typeof required;
            readonly handler: (args: { input: { title: string } }) => Promise<{ ok: true }>;
          };
          readonly optional: {
            readonly inputSchema: typeof optional;
            readonly handler: (args: { input: { note?: string } }) => Promise<{ ok: true }>;
          };
          readonly none: {
            readonly inputSchema: undefined;
            readonly handler: () => Promise<{ ok: true }>;
          };
        };
      };
    };
  };
  type Client = ClientOf<Carrier>;
  expectTypeOf<Client["required"]>().parameters.toEqualTypeOf<[{ title: string }]>();
  expectTypeOf<Client["optional"]>().parameter(0).toEqualTypeOf<{ note: string } | undefined>();
  expectTypeOf<Client["none"]>().parameters.toEqualTypeOf<[]>();
});

test("ClientOf reason codes follow PolicyReasonCodeOf on the action policy", () => {
  type Denied = PolicyReasonCodeCarrier<"NOT_OWNER">;
  type Carrier = {
    readonly "~takibi": {
      readonly collections: { readonly posts: { readonly schema: unknown } };
      readonly actions: {
        readonly posts: {
          readonly touch: {
            readonly target: "document";
            readonly inputSchema: undefined;
            readonly policy: Denied;
            readonly handler: (args: { id: string }) => Promise<{ touched: true }>;
          };
        };
      };
    };
  };
  type Client = ClientOf<Carrier>;
  expectTypeOf<Awaited<ReturnType<Client["posts"]["touch"]>>>().toEqualTypeOf<
    TakibiResult<{ touched: true }, "NOT_OWNER">
  >();
});

test("ClientOf matches createClient and rejects collection maps", () => {
  type Carrier = {
    readonly "~takibi": {
      readonly collections: { readonly posts: { readonly schema: unknown } };
    };
  };
  type FromAlias = ClientOf<Carrier>;
  type FromFactory = ReturnType<typeof createClient<Carrier>>;
  expectTypeOf<FromAlias>().toEqualTypeOf<FromFactory>();

  type Definitions = InferHandlerCollections<Carrier>;
  // @ts-expect-error collection maps are not a ClientOf type source
  type _FromMap = ClientOf<Definitions>;
});
