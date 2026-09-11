import type { QueryExpr } from "@takibi/shared-types";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEvent = {
  level: LogLevel;
  message: string;
  event:
    | "takibi.request"
    | "takibi.resolve"
    | "takibi.wire"
    | "takibi.executor"
    | "takibi.policy"
    | "takibi.schema"
    | "takibi.storage"
    | "takibi.action"
    | "takibi.error";
  durationMs?: number;
  collection?: string;
  operation?: string;
  documentId?: string;
  method?: string;
  path?: string;
  batchSize?: number;
  errorCode?: string;
  status?: number;
  query?: QueryExpr;
};

export type InternalLogger = {
  emit(event: LogEvent): void;
};

export type Logger = {
  log(event: LogEvent): void;
};
