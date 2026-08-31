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

  it("binds a token to its audience and action", async () => {
    const signed = await token();

    await expect(
      verifyShortLivedToken({
        action,
        audience: "https://other.example",
        maxTtlSeconds: 60,
        now,
        secret,
        token: signed,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(
      verifyShortLivedToken({
        action: "takibi:reset:another-tenant",
        audience,
        maxTtlSeconds: 60,
        now,
        secret,
        token: signed,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects expired and excessively long-lived tokens", async () => {
    await expect(
      verifyShortLivedToken({
        action,
        audience,
        maxTtlSeconds: 60,
        now,
        secret,
        token: await token(now),
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
    await expect(
      verifyShortLivedToken({
        action,
        audience,
        maxTtlSeconds: 60,
        now,
        secret,
        token: await token(now + 61),
      }),
    ).resolves.toEqual({ ok: false, reason: "expiry-too-far" });
  });

  it("rejects malformed and tampered tokens", async () => {
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

    const signed = await token();
    const tampered = `${signed.slice(0, -1)}${signed.endsWith("a") ? "b" : "a"}`;
    await expect(
      verifyShortLivedToken({
        action,
        audience,
        maxTtlSeconds: 60,
        now,
        secret,
        token: tampered,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });
});
