import { expectTypeOf, test } from "vite-plus/test";
import type { QueryExpr } from "@takibi/takibi-shared-types";
import type { InternalLogger, LogEvent, Logger, LogLevel } from "../src";

test("log levels and event names stay the shared contract", () => {
  expectTypeOf<LogLevel>().toEqualTypeOf<"debug" | "info" | "warn" | "error">();
  expectTypeOf<LogEvent["event"]>().toEqualTypeOf<
    | "takibi.request"
    | "takibi.resolve"
    | "takibi.wire"
    | "takibi.executor"
    | "takibi.policy"
    | "takibi.schema"
    | "takibi.storage"
    | "takibi.action"
    | "takibi.error"
  >();
  expectTypeOf<LogEvent["query"]>().toEqualTypeOf<QueryExpr | undefined>();
});

test("public Logger and InternalLogger keep distinct sink methods", () => {
  expectTypeOf<Logger["log"]>().toEqualTypeOf<(event: LogEvent) => void>();
  expectTypeOf<InternalLogger["emit"]>().toEqualTypeOf<(event: LogEvent) => void>();
  expectTypeOf<Logger>().not.toHaveProperty("emit");
  expectTypeOf<InternalLogger>().not.toHaveProperty("log");

  const rejectedSink = (logger: InternalLogger) => {
    void logger;
    // @ts-expect-error internal loggers emit events; they do not use log()
    const assigned: InternalLogger = { log() {} };
    void assigned;
  };
  expectTypeOf(rejectedSink).toBeFunction();
});
