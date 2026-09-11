import type { HandleResult } from "takibi";

export async function requestTakibi(
  handler: {
    handle(request: Request, options: { context: Record<string, never> }): Promise<HandleResult>;
  },
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const result = await handler.handle(new Request(input, init), { context: {} });
  if (!result.matched) throw new Error("Expected a matching Takibi test request");
  return result.response;
}
