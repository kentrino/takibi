import { expect, expectTypeOf, test } from "vite-plus/test";
import { runCall } from "../src/index";

type DecodedRequest = { readonly kind: "action"; readonly name: string };
type ResolvedContext = { readonly tenantId: string };
type ResponseObject = { readonly status: number };

function decodedRequest(name: string): DecodedRequest {
  return { kind: "action", name };
}

test("runCall composes decode, resolveContext, and dispatch in linear order", async () => {
  const events: string[] = [];
  const request = new Request("https://example.test/register");
  const response = await runCall(request, {
    decode(received) {
      events.push("decode");
      expect(received).toBe(request);
      return decodedRequest(new URL(received.url).pathname.slice(1));
    },
    async resolveContext(input): Promise<ResolvedContext> {
      events.push("resolveContext");
      expect(input.request).toBe(request);
      return { tenantId: `tenant:${input.decoded.name}` };
    },
    dispatch(input): ResponseObject {
      events.push("dispatch");
      expect(input.request).toBe(request);
      expect(input.decoded).toEqual(decodedRequest("register"));
      return { status: input.context.tenantId === "tenant:register" ? 200 : 500 };
    },
  });

  expect(events).toEqual(["decode", "resolveContext", "dispatch"]);
  expect(response).toEqual({ status: 200 });
  expectTypeOf(response).toEqualTypeOf<ResponseObject>();
});

test.each(["decode", "resolveContext", "dispatch"] as const)(
  "%s failures throw and stop the remaining adapters",
  async (failureStage) => {
    const failure = new Error(`${failureStage} failed`);
    const events: string[] = [];

    await expect(
      runCall(new Request("https://example.test/register"), {
        decode() {
          events.push("decode");
          if (failureStage === "decode") throw failure;
          return decodedRequest("register");
        },
        resolveContext() {
          events.push("resolveContext");
          if (failureStage === "resolveContext") throw failure;
          return { tenantId: "tenant-1" };
        },
        dispatch() {
          events.push("dispatch");
          if (failureStage === "dispatch") throw failure;
          return { status: 200 };
        },
      }),
    ).rejects.toBe(failure);

    expect(events).toEqual(
      failureStage === "decode"
        ? ["decode"]
        : failureStage === "resolveContext"
          ? ["decode", "resolveContext"]
          : ["decode", "resolveContext", "dispatch"],
    );
  },
);

test("undefined values pass through without request sentinels", async () => {
  const response = await runCall("request", {
    decode: () => undefined,
    resolveContext: ({ decoded }) => decoded,
    dispatch: ({ context }) => context,
  });

  expect(response).toBeUndefined();
  expectTypeOf(response).toEqualTypeOf<undefined>();
});
