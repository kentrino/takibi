import type { ResourceOperation } from "./types";

export type WireRequest = {
  resource: string;
  operation: ResourceOperation;
  id?: string;
  input?: unknown;
  list?: { limit?: number; cursor?: string };
  context: {
    tenantId: string;
    user: unknown;
    [key: string]: unknown;
  };
};

export type WireSuccess = { ok: true; data: unknown };
export type WireFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    status: number;
    issues?: unknown;
  };
};
export type WireResponse = WireSuccess | WireFailure;

export function encodeWireRequest(req: WireRequest): string {
  return JSON.stringify(req);
}

export function decodeWireRequest(body: unknown): WireRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Invalid wire request");
  }
  const r = body as Record<string, unknown>;
  if (typeof r.resource !== "string" || typeof r.operation !== "string") {
    throw new Error("Invalid wire request");
  }
  return r as WireRequest;
}
