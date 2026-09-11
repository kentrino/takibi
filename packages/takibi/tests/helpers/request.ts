import { Hono } from "hono";
import { takibiServer, type TakibiHttpHandler } from "../../../hono-adapter/src/index";

export function requestTakibi(
  handler: TakibiHttpHandler<Record<string, never>>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const app = new Hono().use("*", takibiServer({ handler, createContext: () => ({}) }));
  return Promise.resolve(app.request(input, init));
}
