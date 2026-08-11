import type { FireFailure, ResourceOperation } from "./types";

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
  error: FireFailure;
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

export function isWireResponse(value: unknown): value is WireResponse {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.ok === true) return "data" in r;
  if (r.ok !== false) return false;
  const error = r.error;
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (typeof e.code !== "string" || typeof e.message !== "string" || typeof e.status !== "number") {
    return false;
  }
  if (e.kind === "validation") {
    return e.code === "VALIDATION" && e.status === 400 && Array.isArray(e.issues);
  }
  if (e.kind === "operation") return true;
  return false;
}
