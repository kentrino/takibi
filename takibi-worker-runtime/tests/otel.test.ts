import { expect, expectTypeOf, test } from "vite-plus/test";
import { createClass, type InterceptMap } from "@takibi/takibi-utility";
import { otel } from "../src/otel";
import type { InternalLogger, LogEvent } from "../src/logging";

type Probe = {
  greet: (name: string) => Promise<string>;
};

type Ctor = {
  readonly prefix: string;
};

test("otel wraps matching methods through next and reads ctor", async () => {
  const events: LogEvent[] = [];
  const logger: InternalLogger = {
    emit(event) {
      events.push(event);
    },
  };
  const defined = createClass<Probe>()
    .constructor<Ctor>({
      runtimeCheck: true,
    })
    .define("greet", async (deps, name) => `${deps.prefix} ${name}`);

  const interceptors = otel<Probe, Ctor>(logger, {
    greet: {
      name: "takibi.action",
      event: "takibi.action",
      attributes: (ctor) => ({ "takibi.action.name": ctor.prefix }),
      logFields: (ctor) => ({ operation: ctor.prefix }),
    },
  });
  expectTypeOf(interceptors).toMatchTypeOf<Partial<InterceptMap<Probe, Ctor>>>();

  const instance = defined.newWithInterceptors({ prefix: "hi" }, interceptors);
  expect(await instance.greet("ada")).toBe("hi ada");
  expect(events).toEqual([
    expect.objectContaining({
      event: "takibi.action",
      operation: "hi",
    }),
  ]);
});

test("otel only instruments Promise methods while allowing partial mixed method maps", () => {
  type Mixed = Probe & {
    sync: () => string;
    sometimesAsync: () => string | Promise<string>;
  };
  const rejectSync = () =>
    otel<Mixed, Ctor>(undefined, {
      // @ts-expect-error an async interceptor cannot preserve a synchronous return type
      sync: { name: "takibi.action", event: "takibi.action" },
      // @ts-expect-error every invocation must return a Promise
      sometimesAsync: { name: "takibi.action", event: "takibi.action" },
    });
  void rejectSync;

  expect(otel<Mixed, Ctor>(undefined, {})).toEqual({});
  expect(otel<Mixed, Ctor>(undefined, { sync: undefined, greet: undefined })).toEqual({});
  expect(
    otel<Mixed, Ctor>(undefined, {
      greet: { name: "takibi.action", event: "takibi.action" },
    }).greet,
  ).toBeTypeOf("function");
});
