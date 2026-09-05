import {
  decodeBatchItems as decodeProtocolBatchItems,
  decodeCollectionReadRequest as decodeProtocolCollectionReadRequest,
  decodePublicBatch as decodeProtocolPublicBatch,
  decodeWireRequest as decodeProtocolWireRequest,
  parseWireRequest as parseProtocolWireRequest,
  TakibiProtocolError,
  type CollectionReadRequest,
  type PublicBatchRequest,
  type WireRequest,
} from "@takibi/takibi-protocol";
import { BadRequestError } from "./errors";

export {
  COLLECTION_READ_OPERATIONS,
  encodeWireRequest,
  isBatchWireResponse,
  isCollectionReadOperation,
  isWireResponse,
  MAX_BATCH_ITEMS,
} from "@takibi/takibi-protocol";
export type {
  ActionWireRequest,
  BatchWireRequest,
  CollectionReadOperation,
  CollectionReadRequest,
  CollectionWireOperation,
  CollectionWireRequest,
  PublicBatchRequest,
  WireContext,
  WireFailure,
  WireRequest,
  WireResponse,
  WireSuccess,
} from "@takibi/takibi-protocol";

export function parseWireRequest(source: string): WireRequest {
  return mapProtocolError(() => parseProtocolWireRequest(source));
}

export function decodeWireRequest(body: unknown): WireRequest {
  return mapProtocolError(() => decodeProtocolWireRequest(body));
}

export function decodePublicBatch(body: unknown): PublicBatchRequest {
  return mapProtocolError(() => decodeProtocolPublicBatch(body));
}

export function decodeBatchItems(value: unknown): CollectionReadRequest[] {
  return mapProtocolError(() => decodeProtocolBatchItems(value));
}

export function decodeCollectionReadRequest(value: unknown): CollectionReadRequest {
  return mapProtocolError(() => decodeProtocolCollectionReadRequest(value));
}

function mapProtocolError<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof TakibiProtocolError) {
      throw new BadRequestError(error.message);
    }
    throw error;
  }
}
