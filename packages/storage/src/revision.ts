export function documentRevision(document: object | null | undefined): number {
  if (document === null || document === undefined || !("rev" in document)) return 1;
  const rev = document.rev;
  if (typeof rev === "number" && Number.isInteger(rev) && rev >= 1) return rev;
  return 1;
}

export function withDocumentRevision<T extends Record<string, unknown>>(
  document: T,
): T & { rev: number } {
  const rev = documentRevision(document);
  return document.rev === rev ? (document as T & { rev: number }) : { ...document, rev };
}
