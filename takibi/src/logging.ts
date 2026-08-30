import { withSpan, type SpanContext, type SpanSpec } from "./tracing";
import type { QueryExpr, StorageDriver, TakibiFailure } from "./types";

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

export type Logger = {
  log(event: LogEvent): void;
};

export type LoggingOptions = {
  logger?: boolean | Logger;
  logLevel?: LogLevel;
};

export type PrettyConsoleLoggerOptions = {
  colors?: boolean;
};

export type InternalLogger = {
  emit(event: LogEvent): void;
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\u001B[36m",
  info: "\u001B[32m",
  warn: "\u001B[33m",
  error: "\u001B[31m",
};

const RESET_COLOR = "\u001B[0m";

const structuredConsoleLogger: Logger = {
  log(event) {
    console[event.level](event);
  },
};

export function resolveLogging(options: LoggingOptions): InternalLogger | undefined {
  if (options.logger === false) return undefined;
  if (options.logger === undefined && options.logLevel === undefined) return undefined;
  const logger =
    options.logger === true || options.logger === undefined
      ? structuredConsoleLogger
      : options.logger;
  const minimum = LEVEL_PRIORITY[options.logLevel ?? "info"];
  return {
    emit(event) {
      if (LEVEL_PRIORITY[event.level] < minimum) return;
      try {
        logger.log(event);
      } catch {
        // Logging is best-effort and must never change a request result.
      }
    },
  };
}

export function createPrettyConsoleLogger(options: PrettyConsoleLoggerOptions = {}): Logger {
  const colors = options.colors ?? false;
  return {
    log(event) {
      const level = colors
        ? `${LEVEL_COLOR[event.level]}${event.level}${RESET_COLOR}`
        : event.level;
      const fields = [
        `[${level}]`,
        event.event,
        event.message,
        event.method === undefined ? undefined : `method=${event.method}`,
        event.path === undefined ? undefined : `path=${event.path}`,
        event.collection === undefined ? undefined : `collection=${event.collection}`,
        event.operation === undefined ? undefined : `operation=${event.operation}`,
        event.documentId === undefined ? undefined : `documentId=${event.documentId}`,
        event.batchSize === undefined ? undefined : `batchSize=${event.batchSize}`,
        event.durationMs === undefined
          ? undefined
          : `durationMs=${formatDuration(event.durationMs)}`,
        event.errorCode === undefined ? undefined : `errorCode=${event.errorCode}`,
        event.status === undefined ? undefined : `status=${event.status}`,
        event.query === undefined ? undefined : `query=${JSON.stringify(event.query)}`,
      ].filter((field): field is string => field !== undefined);
      console[event.level](fields.join(" "));
    },
  };
}

export async function withLoggedSpan<T>(
  logger: InternalLogger | undefined,
  spec: SpanSpec,
  event: Omit<LogEvent, "level" | "message" | "event" | "durationMs"> & {
    event: Exclude<LogEvent["event"], "takibi.request" | "takibi.error">;
    message?: string;
  },
  fn: () => Promise<T>,
  parentOverride?: SpanContext,
): Promise<T> {
  return withSpan(
    spec,
    async () => {
      const startedAt = performance.now();
      try {
        return await fn();
      } finally {
        logger?.emit({
          level: "debug",
          event: event.event,
          message: event.message ?? "completed",
          ...copyEventFields(event),
          durationMs: performance.now() - startedAt,
        });
      }
    },
    parentOverride,
  );
}

export function requestLogFields(request: Request): Pick<LogEvent, "method" | "path"> {
  return {
    method: request.method,
    path: new URL(request.url).pathname,
  };
}

export function emitFailure(
  logger: InternalLogger | undefined,
  failure: TakibiFailure,
  fields: Pick<LogEvent, "collection" | "operation" | "documentId" | "method" | "path"> = {},
): void {
  logger?.emit({
    level: "error",
    event: "takibi.error",
    message: failure.message,
    ...fields,
    errorCode: failure.code,
    status: failure.status,
  });
}

export function loggedStorage(
  driver: StorageDriver,
  logger: InternalLogger | undefined,
): StorageDriver {
  const wrap = (next: StorageDriver): StorageDriver => ({
    get: (collection, id) =>
      withStorageLog(
        logger,
        {
          collection,
          operation: "get",
          documentId: id,
        },
        () => next.get(collection, id),
      ),
    put: (collection, document) =>
      withStorageLog(
        logger,
        {
          collection,
          operation: "put",
          documentId: document.id,
        },
        () => next.put(collection, document),
      ),
    delete: (collection, id) =>
      withStorageLog(
        logger,
        {
          collection,
          operation: "delete",
          documentId: id,
        },
        () => next.delete(collection, id),
      ),
    list: (collection, options, plan) =>
      withStorageLog(
        logger,
        {
          collection,
          operation: "list",
          ...(options?.where === undefined ? {} : { query: options.where }),
        },
        () => next.list(collection, options, plan),
      ),
    transaction: (callback) =>
      withStorageLog(logger, { operation: "transaction" }, () =>
        next.transaction((scoped) => callback(wrap(scoped))),
      ),
  });
  return wrap(driver);
}

async function withStorageLog<T>(
  logger: InternalLogger | undefined,
  fields: Pick<LogEvent, "collection" | "operation" | "documentId" | "query">,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    logger?.emit({
      level: "debug",
      event: "takibi.storage",
      message: "completed",
      ...copyEventFields(fields),
      durationMs: performance.now() - startedAt,
    });
  }
}

function copyEventFields(
  event: Omit<LogEvent, "level" | "message" | "event" | "durationMs">,
): Pick<LogEvent, "collection" | "operation" | "documentId" | "query" | "batchSize"> {
  return {
    ...(event.collection === undefined ? {} : { collection: event.collection }),
    ...(event.operation === undefined ? {} : { operation: event.operation }),
    ...(event.documentId === undefined ? {} : { documentId: event.documentId }),
    ...(event.query === undefined ? {} : { query: cloneQuery(event.query) }),
    ...(event.batchSize === undefined ? {} : { batchSize: event.batchSize }),
  };
}

function cloneQuery(query: QueryExpr): QueryExpr {
  if ("field" in query) {
    return query.op === "present"
      ? { field: query.field, op: query.op }
      : { field: query.field, op: query.op, value: query.value };
  }
  if (query.op === "not") {
    return { op: "not", operand: cloneQuery(query.operand) };
  }
  return { op: query.op, operands: query.operands.map(cloneQuery) };
}

function formatDuration(durationMs: number): string {
  return Number.isInteger(durationMs) ? String(durationMs) : durationMs.toFixed(3);
}
