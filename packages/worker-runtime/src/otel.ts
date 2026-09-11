import type { AnyMethod, InterceptMap, MethodMap } from "@takibi/utility";
import { withLoggedSpan, type InternalLogger, type LogEvent } from "./logging";
import type { SpanAttributes, SpanKind } from "./tracing";

export type OtelMethodSpec<TCtor, M extends AnyMethod> = {
  readonly name: string;
  readonly kind?: SpanKind;
  readonly event: Exclude<LogEvent["event"], "takibi.request" | "takibi.error">;
  readonly attributes?: (ctor: TCtor, args: Parameters<M>) => SpanAttributes | undefined;
  readonly logFields?: (
    ctor: TCtor,
    args: Parameters<M>,
  ) => Omit<LogEvent, "level" | "message" | "event" | "durationMs">;
};

export type OtelSpec<T extends MethodMap, TCtor> = {
  readonly [K in keyof T]?: ReturnType<T[K]> extends Promise<unknown>
    ? OtelMethodSpec<TCtor, T[K]>
    : never;
};

/**
 * Build `newWithInterceptors` layers from span specs. Uses `next` so later
 * layers stay composed. Methods must return a Promise; `withLoggedSpan` is async.
 */
export function otel<T extends MethodMap, TCtor>(
  logger: InternalLogger | undefined,
  spec: OtelSpec<T, TCtor>,
): Partial<InterceptMap<T, TCtor>> {
  const interceptors: Partial<InterceptMap<T, TCtor>> = {};
  for (const key of Object.keys(spec) as (keyof T & string)[]) {
    const methodSpec = spec[key];
    if (methodSpec === undefined) continue;
    interceptors[key] = ((context) => {
      const attributes = methodSpec.attributes?.(context.ctor, context.args);
      return withLoggedSpan(
        logger,
        {
          name: methodSpec.name,
          kind: methodSpec.kind ?? "internal",
          ...(attributes === undefined ? {} : { attributes }),
        },
        {
          event: methodSpec.event,
          ...methodSpec.logFields?.(context.ctor, context.args),
        },
        () => Promise.resolve(context.next(...context.args)),
      );
    }) as InterceptMap<T, TCtor>[typeof key];
  }
  return interceptors;
}
