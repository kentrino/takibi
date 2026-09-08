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
    callDecode(received) {
      events.push("decode");
      expect(received).toBe(request);
      return decodedRequest(new URL(received.url).pathname.slice(1));
    },
    async callResolveContext(input): Promise<ResolvedContext> {
      events.push("resolveContext");
      expect(input.request).toBe(request);
      return { tenantId: `tenant:${input.decoded.name}` };
    },
    callDispatch(input): ResponseObject {
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
        callDecode() {
          events.push("decode");
          if (failureStage === "decode") throw failure;
          return decodedRequest("register");
        },
        callResolveContext() {
          events.push("resolveContext");
          if (failureStage === "resolveContext") throw failure;
          return { tenantId: "tenant-1" };
        },
        callDispatch() {
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
    callDecode() {
      events.push("decode");
      return { name: "register" };
    },
    callOnDecoded() {
      events.push("started");
    },
    callResolveContext() {
      events.push("resolve");
      return { tenantId: "tenant-1" };
    },
    callDispatch() {
      events.push("dispatch");
      return { status: 200 };
    },
    callOnTerminal(event) {
      events.push(event.outcome);
    },
  });
  expect(events).toEqual(["decode", "started", "resolve", "dispatch", "responded"]);

  const failedEvents: string[] = [];
  await expect(
    runCall("request", {
      callDecode() {
        failedEvents.push("decode");
        throw new Error("DECODE");
      },
      callOnDecoded() {
        failedEvents.push("started");
      },
      callResolveContext() {
        failedEvents.push("resolve");
        return { tenantId: "tenant-1" };
      },
      callDispatch() {
        failedEvents.push("dispatch");
        return { status: 200 };
      },
    }),
  ).rejects.toThrow("DECODE");
  expect(failedEvents).toEqual(["decode"]);
});

test("toFailureResponse converts once and a converter failure rejects", async () => {
  const converted = await runCall("request", {
    callDecode: () => {
      throw new Error("DECODE");
    },
    callResolveContext: () => ({ tenantId: "tenant-1" }),
    callDispatch: () => ({ status: 200 }),
    callToFailureResponse(failure) {
      expect(failure.stage).toBe("decode");
      expect(failure.decoded).toBeUndefined();
      return { status: 400 };
    },
  });
  expect(converted).toEqual({ status: 400 });

  await expect(
    runCall("request", {
      callDecode: () => ({ name: "register" }),
      callResolveContext: () => {
        throw new Error("RESOLVE");
      },
      callDispatch: () => ({ status: 200 }),
      callToFailureResponse() {
        throw new Error("CONVERTER");
      },
    }),
  ).rejects.toThrow("CONVERTER");
});

test("observer failures do not replace the Call result", async () => {
  const response = await runCall("request", {
    callDecode: () => ({ name: "register" }),
    callOnDecoded() {
      throw new Error("started observer failed");
    },
    callResolveContext: () => ({ tenantId: "tenant-1" }),
    callDispatch: () => ({ status: 200 }),
    callOnTerminal() {
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
    callDecode: () => decoded,
    callOnDecoded() {
      throw new Error("started observer failed");
    },
    callResolveContext: () => {
      throw new Error("RESOLVE");
    },
    callDispatch: () => ({ status: 200 }),
    callToFailureResponse(failure) {
      failureDecoded = failure.decoded;
      expect(failure.request).toBe("request");
      return { status: 400 };
    },
    callOnTerminal(event) {
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
    callDecode: () => ({ name: "register" }),
    callResolveContext() {
      events.push("adapter");
      return { tenantId: "tenant-1" };
    },
    callDispatch() {
      events.push("dispatch");
      return { status: 200 };
    },
  }).run("request");

  expect(events).toEqual(["override", "adapter", "dispatch"]);
  expect(response).toEqual({ status: 200 });
});

test("Call is a class instance constructed from envelope adapter-map slots", async () => {
  const call = new Call({
    callDecode: () => ({ name: "register" }),
    callResolveContext: () => ({ tenantId: "tenant-1" }),
    callDispatch: () => ({ status: 200 }),
  });
  expect(call).toBeInstanceOf(Call);
  await expect(call.run("request")).resolves.toEqual({ status: 200 });
});

test("undefined values pass through without request sentinels", async () => {
  const response = await runCall("request", {
    callDecode: () => undefined,
    callResolveContext: ({ decoded }) => decoded,
    callDispatch: ({ context }) => context,
  });

  expect(response).toBeUndefined();
  expectTypeOf(response).toEqualTypeOf<undefined>();
});
