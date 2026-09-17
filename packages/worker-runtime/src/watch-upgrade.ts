import { BadRequestError, ForbiddenError, TakibiError } from "@takibi/api";
import {
  TakibiProtocolError,
  WATCH_PROTOCOL,
  WATCH_VERSION,
  WATCH_ATTACHMENT_MAX_BYTES,
  normalizeWatchList,
  type WatchAttachment,
} from "@takibi/protocol";
import type { PublicRequest } from "./http";
import { assertSerializableContext, errorResponse } from "./context/runtime";
import type { ContextResolver } from "./context/types";
import type { InternalLogger } from "./logging";

export const WATCH_HEADER = "x-takibi-watch";
export type WatchUpgrade<TInitial, TCtx extends object> = (input: {
  request: Request;
  initial: TInitial;
  attachment: WatchAttachment;
  ctx: TCtx & Record<string, unknown>;
}) => Promise<Response>;

export function assertWatchProtocols(request: Request): void {
  const tokens =
    request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((token) => token.trim()) ?? [];
  const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  if (
    !tokens.includes(WATCH_PROTOCOL) ||
    tokens.some((token) => !tokenPattern.test(token)) ||
    new Set(tokens).size !== tokens.length
  ) {
    throw new BadRequestError("Unsupported or invalid watch subprotocol");
  }
}

export function encodeWatchAttachment(attachment: WatchAttachment): string {
  assertSerializableContext(attachment.context);
  const serialized = JSON.stringify(attachment);
  if (new TextEncoder().encode(serialized).byteLength > WATCH_ATTACHMENT_MAX_BYTES) {
    throw new BadRequestError(`Watch attachment exceeds ${WATCH_ATTACHMENT_MAX_BYTES} bytes`);
  }
  return serialized;
}

export async function serveWatchUpgrade<TInitial, TCtx extends object>(input: {
  request: Request;
  initial: TInitial;
  decode: () => Promise<PublicRequest>;
  resolve: ContextResolver<TCtx, TInitial>;
  upgrade?: WatchUpgrade<TInitial, TCtx>;
  logger: InternalLogger | undefined;
}): Promise<Response> {
  try {
    const { request } = input;
    assertWatchProtocols(request);
    const origin = request.headers.get("origin");
    if (request.headers.has("cookie") && origin !== new URL(request.url).origin) {
      throw new ForbiddenError(
        "Cookie-authenticated watches require a same-origin browser request",
      );
    }
    const decoded = await input.decode();
    if (request.method !== "GET" || decoded.kind !== "collection" || decoded.operation !== "list") {
      throw new BadRequestError("Watch requires a collection GET");
    }
    const list = normalizeWatchList(decoded.list ?? {});
    const ctx = await input.resolve({ request, context: input.initial });
    assertSerializableContext(ctx);
    const attachment: WatchAttachment = {
      version: WATCH_VERSION,
      collection: decoded.collection,
      list,
      context: ctx,
    };
    encodeWatchAttachment(attachment);
    if (!input.upgrade)
      throw new TakibiError("WATCH_UNAVAILABLE", "Watch requires a Durable Object backend", 400);
    return await input.upgrade({ request, initial: input.initial, attachment, ctx });
  } catch (error) {
    return errorResponse(
      error instanceof TakibiProtocolError ? new BadRequestError(error.message) : error,
      input.logger,
    );
  }
}
