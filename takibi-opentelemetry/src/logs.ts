import { context } from "@opentelemetry/api";
import {
  SeverityNumber,
  type LogAttributes,
  type Logger as OtelLogger,
} from "@opentelemetry/api-logs";
import type { LogEvent, Logger } from "@takibi/takibi";

const SEVERITY_NUMBER = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

export function createOtelLogger(logger: OtelLogger): Logger {
  return {
    log(event) {
      logger.emit({
        eventName: event.event,
        body: event.message,
        severityText: event.level.toUpperCase(),
        severityNumber: SEVERITY_NUMBER[event.level],
        attributes: eventAttributes(event),
        context: context.active(),
      });
    },
  };
}

function eventAttributes(event: LogEvent): LogAttributes {
  return {
    "takibi.event.name": event.event,
    ...(event.collection === undefined ? {} : { "takibi.collection.name": event.collection }),
    ...(event.operation === undefined ? {} : { "takibi.operation.name": event.operation }),
    ...(event.documentId === undefined ? {} : { "takibi.document.id": event.documentId }),
    ...(event.method === undefined ? {} : { "takibi.http.method": event.method }),
    ...(event.path === undefined ? {} : { "takibi.http.path": event.path }),
    ...(event.errorCode === undefined ? {} : { "takibi.error.code": event.errorCode }),
    ...(event.status === undefined ? {} : { "takibi.response.status": event.status }),
    ...(event.durationMs === undefined ? {} : { "takibi.duration.ms": event.durationMs }),
    ...(event.query === undefined ? {} : { "takibi.query": JSON.stringify(event.query) }),
    ...(event.batchSize === undefined ? {} : { "takibi.batch.size": event.batchSize }),
  };
}
