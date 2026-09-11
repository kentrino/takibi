import { describe, expect, it } from "vite-plus/test";
import { createShortLivedToken, verifyShortLivedToken } from "./short-lived-token";

const secret = "test-maintenance-secret-at-least-32-characters";
const audience = "https://clinic.example";
const action = "takibi:reset:takibi";
const now = 1_800_000_000;

async function token(expiresAt = now + 30) {
  return createShortLivedToken({
    action,
    audience,
    expiresAt,
    secret,
  });
}

describe("short-lived tokens", () => {
  it("accepts a matching token inside its lifetime", async () => {
    const result = await verifyShortLivedToken({
      action,
      audience,
      maxTtlSeconds: 60,
      now,
      secret,
      token: await token(),
    });

    expect(result).toEqual({ ok: true, expiresAt: now + 30 });
  });

  it.each([
    { name: "another audience", audience: "https://other.example", action, secret },
    { name: "another action", audience, action: "takibi:reset:another-tenant", secret },
    { name: "another secret", audience, action, secret: "different-maintenance-secret" },
  ])("rejects a token verified with $name", async (verification) => {
    const signed = await token();

    await expect(
      verifyShortLivedToken({
        ...verification,
        maxTtlSeconds: 60,
        now,
        token: signed,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it.each([
    {
      name: "one second before expiry",
      now: 1_800_000_029,
      expected: { ok: true, expiresAt: 1_800_000_030 },
    },
    { name: "at expiry", now: 1_800_000_030, expected: { ok: false, reason: "expired" } },
    { name: "after expiry", now: 1_800_000_031, expected: { ok: false, reason: "expired" } },
    {
      name: "exactly the maximum TTL",
      now: 1_799_999_970,
      expected: { ok: true, expiresAt: 1_800_000_030 },
    },
    {
      name: "one second beyond the maximum TTL",
      now: 1_799_999_969,
      expected: { ok: false, reason: "expiry-too-far" },
    },
  ])("verifies a token $name", async ({ now: verificationTime, expected }) => {
    const signed = await token(1_800_000_030);

    await expect(
      verifyShortLivedToken({
        action,
        audience,
        maxTtlSeconds: 60,
        now: verificationTime,
        secret,
        token: signed,
      }),
    ).resolves.toEqual(expected);
  });

  it("rejects a malformed token", async () => {
    await expect(
      verifyShortLivedToken({
        action,
        audience,
        maxTtlSeconds: 60,
        now,
        secret,
        token: "not-a-token",
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a modified signature byte", async () => {
    const signed = await token();
    const [version, expiresAt, signature] = signed.split(".");
    const bytes = Buffer.from(signature!, "base64url");
    bytes[0] = bytes[0]! ^ 1;
    const tampered = `${version}.${expiresAt}.${bytes.toString("base64url")}`;

    await expect(
      verifyShortLivedToken({ action, audience, maxTtlSeconds: 60, now, secret, token: tampered }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an extended expiry even when it is within the allowed TTL", async () => {
    const signed = await token(1_800_000_030);
    const [version, , signature] = signed.split(".");
    const tampered = `${version}.1800000040.${signature}`;

    await expect(
      verifyShortLivedToken({ action, audience, maxTtlSeconds: 60, now, secret, token: tampered }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });
});
