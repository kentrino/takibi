const TOKEN_VERSION = "v1";
const encoder = new TextEncoder();

export type ShortLivedTokenVerification =
  | { ok: true; expiresAt: number }
  | {
      ok: false;
      reason: "expired" | "expiry-too-far" | "invalid";
    };

export async function createShortLivedToken(input: {
  action: string;
  audience: string;
  expiresAt: number;
  secret: string;
}): Promise<string> {
  assertUnixSeconds(input.expiresAt);
  const signature = await sign(input.secret, payload(input));
  return `${TOKEN_VERSION}.${input.expiresAt}.${toBase64Url(signature)}`;
}

export async function verifyShortLivedToken(input: {
  action: string;
  audience: string;
  maxTtlSeconds: number;
  now?: number;
  secret: string;
  token: string;
}): Promise<ShortLivedTokenVerification> {
  const [version, expiresAtRaw, signatureRaw, ...extra] = input.token.split(".");
  if (
    version !== TOKEN_VERSION ||
    expiresAtRaw === undefined ||
    signatureRaw === undefined ||
    extra.length > 0
  ) {
    return { ok: false, reason: "invalid" };
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return { ok: false, reason: "invalid" };
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }
  if (expiresAt > now + input.maxTtlSeconds) {
    return { ok: false, reason: "expiry-too-far" };
  }

  const signature = fromBase64Url(signatureRaw);
  if (signature === null) {
    return { ok: false, reason: "invalid" };
  }

  const key = await importKey(input.secret, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(
      payload({
        action: input.action,
        audience: input.audience,
        expiresAt,
      }),
    ),
  );
  return valid ? { ok: true, expiresAt } : { ok: false, reason: "invalid" };
}

function payload(input: { action: string; audience: string; expiresAt: number }): string {
  return `${TOKEN_VERSION}\n${input.audience}\n${input.action}\n${input.expiresAt}`;
}

async function sign(secret: string, value: string): Promise<ArrayBuffer> {
  const key = await importKey(secret, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

function importKey(secret: string, usages: Array<"sign" | "verify">) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function assertUnixSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("expiresAt must be a non-negative Unix timestamp in seconds");
  }
}

function toBase64Url(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  try {
    const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}
