import { describe, expect, it, vi } from "vite-plus/test";
import { observeCommits } from "../src/observe-commits";
import type { StorageDriver, StoredDocument } from "../src/types";

function fixture() {
  const driver: StorageDriver = {
    get: async () => null,
    list: async () => ({ items: [] }),
    put: async () => {},
    delete: async () => true,
    transaction: async (run) => run(driver),
  };
  const publish = vi.fn();
  return { driver, publish, observed: observeCommits(driver, publish) };
}
const doc = { id: "a" } as StoredDocument;

describe("commit observation", () => {
  it("publishes once after the outer commit, including nested scoped writes", async () => {
    const { observed, publish } = fixture();
    await observed.transaction(async (tx) => {
      await tx.put("posts", doc);
      await tx.transaction(async (nested) => {
        await nested.delete("posts", "a");
      });
      await tx.put("users", doc);
      expect(publish).not.toHaveBeenCalled();
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(new Set(["posts", "users"]));
  });
  it("discards rollback and unknown commit outcomes", async () => {
    const { observed, publish, driver } = fixture();
    await expect(
      observed.transaction(async (tx) => {
        await tx.put("posts", doc);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    driver.transaction = async (run) => {
      await run(driver);
      throw new Error("commit failed");
    };
    await expect(observed.transaction(async (tx) => tx.put("posts", doc))).rejects.toThrow(
      "commit failed",
    );
    expect(publish).not.toHaveBeenCalled();
  });
  it("isolates observer errors and ignores reads and unsuccessful deletes", async () => {
    const { observed, publish, driver } = fixture();
    publish.mockImplementation(() => {
      throw new Error("observer");
    });
    await observed.put("posts", doc);
    publish.mockClear();
    driver.delete = async () => false;
    await observed.delete("posts", "missing");
    await observed.list("posts");
    expect(publish).not.toHaveBeenCalled();
  });
});
it("retains joined nested writes when their error is caught by the outer transaction", async () => {
  const { observed, publish } = fixture();
  await observed.transaction(async (tx) => {
    await expect(
      tx.transaction(async (nested) => {
        await nested.put("posts", doc);
        throw new Error("caught by owner");
      }),
    ).rejects.toThrow("caught by owner");
    expect(publish).not.toHaveBeenCalled();
  });
  expect(publish).toHaveBeenCalledExactlyOnceWith(new Set(["posts"]));
});
