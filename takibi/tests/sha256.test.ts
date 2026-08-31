import { expect, test } from "vite-plus/test";
import { Sha256 } from "../src/sha256";

const encoder = new TextEncoder();

test("incremental SHA-256 matches standard vectors", () => {
  const empty = new Sha256();
  expect(empty.digestHex()).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );

  const split = new Sha256();
  split.update(encoder.encode("a"));
  split.update(encoder.encode("b"));
  split.update(encoder.encode("c"));
  expect(split.digestHex()).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
