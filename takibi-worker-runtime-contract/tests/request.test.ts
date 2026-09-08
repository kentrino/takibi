import { expect, expectTypeOf, test } from "vite-plus/test";
import { Call, runCall } from "../src/index";

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

test("decode success is observed before resolve and decode failure is not started", async () => {
  const events: string[] = [];
  await runCall("request", {
    decode() {
      events.push("decode");
      return { name: "register" };
    },
    onDecoded() {
      events.push("started");
    },
    resolveContext() {
      events.push("resolve");
      return { tenantId: "tenant-1" };
    },
    dispatch() {
      events.push("dispatch");
      return { status: 200 };
    },
    onTerminal(event) {
      events.push(event.outcome);
    },
  });
  expect(events).toEqual(["decode", "started", "resolve", "dispatch", "responded"]);

  const failedEvents: string[] = [];
  await expect(
    runCall("request", {
      decode() {
        failedEvents.push("decode");
        throw new Error("DECODE");
      },
      onDecoded() {
        failedEvents.push("started");
      },
      resolveContext() {
        failedEvents.push("resolve");
        return { tenantId: "tenant-1" };
      },
      dispatch() {
        failedEvents.push("dispatch");
        return { status: 200 };
      },
    }),
  ).rejects.toThrow("DECODE");
  expect(failedEvents).toEqual(["decode"]);
});

test("toFailureResponse converts once and a converter failure rejects", async () => {
  const converted = await runCall("request", {
    decode: () => {
      throw new Error("DECODE");
    },
    resolveContext: () => ({ tenantId: "tenant-1" }),
    dispatch: () => ({ status: 200 }),
    toFailureResponse(failure) {
      expect(failure.stage).toBe("decode");
      expect(failure.decoded).toBeUndefined();
      return { status: 400 };
    },
  });
  expect(converted).toEqual({ status: 400 });

  await expect(
    runCall("request", {
      decode: () => ({ name: "register" }),
      resolveContext: () => {
        throw new Error("RESOLVE");
      },
      dispatch: () => ({ status: 200 }),
      toFailureResponse() {
        throw new Error("CONVERTER");
      },
    }),
  ).rejects.toThrow("CONVERTER");
});

test("observer failures do not replace the Call result", async () => {
  const response = await runCall("request", {
    decode: () => ({ name: "register" }),
    onDecoded() {
      throw new Error("started observer failed");
    },
    resolveContext: () => ({ tenantId: "tenant-1" }),
    dispatch: () => ({ status: 200 }),
    onTerminal() {
      throw new Error("terminal observer failed");
    },
  });
  expect(response).toEqual({ status: 200 });
});

test("decoded reaches failure and terminal even when onDecoded throws", async () => {
  const decoded = { name: "register" };
  let failureDecoded: unknown;
  let terminalDecoded: unknown;
  let terminalRequest: unknown;

  const converted = await runCall("request", {
    decode: () => decoded,
    onDecoded() {
      throw new Error("started observer failed");
    },
    resolveContext: () => {
      throw new Error("RESOLVE");
    },
    dispatch: () => ({ status: 200 }),
    toFailureResponse(failure) {
      failureDecoded = failure.decoded;
      expect(failure.request).toBe("request");
      return { status: 400 };
    },
    onTerminal(event) {
      expect(event.outcome).toBe("responded");
      if (event.outcome === "responded") {
        terminalDecoded = event.decoded;
        terminalRequest = event.request;
      }
    },
  });

  expect(converted).toEqual({ status: 400 });
  expect(failureDecoded).toBe(decoded);
  expect(terminalDecoded).toBe(decoded);
  expect(terminalRequest).toBe("request");
});

test("Call.run uses this.resolveContext so a subclass or withTracing wrapper is observed", async () => {
  const events: string[] = [];
  class ProbeCall extends Call<string, { name: string }, { tenantId: string }, { status: number }> {
    override async resolveContext(input: {
      request: string;
      decoded: { name: string };
    }): Promise<{ tenantId: string }> {
      events.push("override");
      return super.resolveContext(input);
    }
  }

  const response = await new ProbeCall({
    decode: () => ({ name: "register" }),
    resolveContext() {
      events.push("adapter");
      return { tenantId: "tenant-1" };
    },
    dispatch() {
      events.push("dispatch");
      return { status: 200 };
    },
  }).run("request");

  expect(events).toEqual(["override", "adapter", "dispatch"]);
  expect(response).toEqual({ status: 200 });
});

test("undefined values pass through without request sentinels", async () => {
  const response = await runCall("request", {
    decode: () => undefined,
    resolveContext: ({ decoded }) => decoded,
    dispatch: ({ context }) => context,
  });

  expect(response).toBeUndefined();
  expectTypeOf(response).toEqualTypeOf<undefined>();
});
