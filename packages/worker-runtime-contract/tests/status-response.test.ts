import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  jsonResponseFromStatus,
  statusOfResult,
  type JsonResponseLike,
  type StatusBearingResult,
} from "../src";

test("statusOfResult maps ok to 200 and failure to error.status", () => {
  expect(statusOfResult({ ok: true })).toBe(200);
  expect(statusOfResult({ ok: false, error: { status: 404 } })).toBe(404);
});

test("jsonResponseFromStatus uses JsonResponseLike and keeps extra result fields", () => {
  const recorded: { body: unknown; status?: number }[] = [];
  const response: JsonResponseLike<{ body: unknown; status?: number }> = {
    json(body, init) {
      const value = { body, status: init?.status };
      recorded.push(value);
      return value;
    },
  };

  const success = { ok: true as const, data: { id: "patient-1" } };
  const failure = { ok: false as const, error: { status: 404, code: "NOT_FOUND" } };
  expectTypeOf(success).toExtend<StatusBearingResult>();
  expectTypeOf(failure).toExtend<StatusBearingResult>();

  expect(jsonResponseFromStatus(success, response)).toEqual({
    body: success,
    status: 200,
  });
  expect(jsonResponseFromStatus(failure, response)).toEqual({
    body: failure,
    status: 404,
  });
  expect(recorded).toHaveLength(2);
});
