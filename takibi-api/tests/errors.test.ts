import { expect, test } from "vite-plus/test";
import {
  AlreadyExistsError,
  ForbiddenError,
  ListAllLimitError,
  StaleWriteError,
  TakibiError,
} from "../src";

test("public error classes keep their codes, status, and names", () => {
  const exists = new AlreadyExistsError();
  expect(exists).toBeInstanceOf(TakibiError);
  expect(exists.code).toBe("ALREADY_EXISTS");
  expect(exists.status).toBe(409);
  expect(exists.name).toBe("AlreadyExistsError");

  const stale = new StaleWriteError();
  expect(stale.code).toBe("STALE_WRITE");
  expect(stale.status).toBe(409);

  const limit = new ListAllLimitError(10);
  expect(limit.code).toBe("LIST_ALL_LIMIT");
  expect(limit.status).toBe(400);
  expect(limit.message).toBe("listAll exceeded the maximum of 10 documents");

  const forbidden = new ForbiddenError("no", { code: "DENIED" });
  expect(forbidden.code).toBe("FORBIDDEN");
  expect(forbidden.status).toBe(403);
  expect(forbidden.reason).toEqual({ code: "DENIED" });
});
