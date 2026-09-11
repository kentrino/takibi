import { expect, test } from "vite-plus/test";
import { documentRevision, withDocumentRevision } from "../src";

test("documentRevision defaults missing or invalid values to 1", () => {
  expect(documentRevision(undefined)).toBe(1);
  expect(documentRevision(null)).toBe(1);
  expect(documentRevision({})).toBe(1);
  expect(documentRevision({ rev: 0 })).toBe(1);
  expect(documentRevision({ rev: 1.5 })).toBe(1);
  expect(documentRevision({ rev: "4" })).toBe(1);
  expect(documentRevision({ rev: 9 })).toBe(9);
  expect(documentRevision({ rev: 2 ** 53 })).toBe(2 ** 53);
});

test("withDocumentRevision writes rev only when the stored value differs", () => {
  const already = { id: "p1", rev: 3 };
  expect(withDocumentRevision(already)).toBe(already);
  expect(withDocumentRevision({ id: "p2" })).toEqual({ id: "p2", rev: 1 });
  expect(withDocumentRevision({ id: "p3", rev: 1.5 })).toEqual({ id: "p3", rev: 1 });
});
