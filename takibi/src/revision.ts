import { StaleWriteError, TakibiError } from "@takibi/takibi-api";
import { SchemaValidationError } from "./schema";
import { TAKIBI_REVISION_KEY } from "./types";

export function documentRevision(document: object | null | undefined): number {
  if (document === null || document === undefined || !("rev" in document)) return 1;
  const rev = document.rev;
  if (typeof rev === "number" && Number.isInteger(rev) && rev >= 1) return rev;
  return 1;
}

/** Advance `rev` so the result is strictly greater as an IEEE-754 number. */
export function nextDocumentRevision(current: number): number {
  const incremented = current + 1;
  if (incremented > current && Number.isFinite(incremented)) return incremented;
  const exponent = Math.floor(Math.log2(current));
  const ulp = 2 ** Math.max(exponent - 52, 0);
  const next = current + ulp;
  if (next > current && Number.isFinite(next)) return next;
  throw new TakibiError("INVALID_DOCUMENT", "Document revision cannot advance", 500);
}

export function assertRevisionPrecondition(
  existing: object | null | undefined,
  expectedRev: number | undefined,
): void {
  if (expectedRev === undefined) return;
  if (!existing || documentRevision(existing) !== expectedRev) {
    throw new StaleWriteError();
  }
}

export function withDocumentRevision<T extends Record<string, unknown>>(
  document: T,
): T & { rev: number } {
  const rev = documentRevision(document);
  return document.rev === rev ? (document as T & { rev: number }) : { ...document, rev };
}

export function takeRevisionPrecondition(input: unknown): {
  data: unknown;
  expectedRev: number | undefined;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { data: input, expectedRev: undefined };
  }
  if (!Object.prototype.hasOwnProperty.call(input, TAKIBI_REVISION_KEY)) {
    return { data: input, expectedRev: undefined };
  }
  const expectedRev = (input as Record<string, unknown>)[TAKIBI_REVISION_KEY];
  if (typeof expectedRev !== "number" || !Number.isInteger(expectedRev) || expectedRev < 1) {
    throw new SchemaValidationError([
      { message: "rev must be a positive integer", path: [TAKIBI_REVISION_KEY] },
    ]);
  }
  const { [TAKIBI_REVISION_KEY]: _rev, ...data } = input as Record<string, unknown>;
  return { data, expectedRev };
}
