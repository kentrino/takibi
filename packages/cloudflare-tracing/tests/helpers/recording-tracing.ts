import type { CloudflareSpan, CloudflareTracing } from "../../src/index";

export type RecordedCloudflareSpan = {
  name: string;
  parentName?: string;
  attributes: Record<string, boolean | number | string>;
  ended: boolean;
  endCount: number;
};

export function createRecordingCloudflareTracing(): CloudflareTracing & {
  spans: RecordedCloudflareSpan[];
} {
  const spans: RecordedCloudflareSpan[] = [];
  const stack: RecordedCloudflareSpan[] = [];

  const tracing: CloudflareTracing & { spans: RecordedCloudflareSpan[] } = {
    spans,
    enterSpan(name, callback, ...args) {
      const recorded: RecordedCloudflareSpan = {
        name,
        attributes: {},
        ended: false,
        endCount: 0,
        ...(stack.at(-1) ? { parentName: stack.at(-1)!.name } : {}),
      };
      spans.push(recorded);
      const span: CloudflareSpan = {
        get isTraced() {
          return !recorded.ended;
        },
        setAttribute(key, value) {
          if (value === undefined || recorded.ended) return;
          recorded.attributes[key] = value;
        },
        end() {
          if (recorded.ended) return;
          recorded.ended = true;
          recorded.endCount += 1;
        },
      };
      stack.push(recorded);
      const leave = () => {
        if (stack.at(-1) === recorded) stack.pop();
        span.end();
      };
      try {
        const result = callback(span, ...args);
        if (isThenable(result)) {
          return result.then(
            (value) => {
              leave();
              return value;
            },
            (error: unknown) => {
              leave();
              throw error;
            },
          ) as ReturnType<typeof callback>;
        }
        leave();
        return result;
      } catch (error) {
        leave();
        throw error;
      }
    },
  };
  return tracing;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}
