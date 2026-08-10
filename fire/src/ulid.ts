/** Crockford's Base32 (ULID): excludes I, L, O, U. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Module-local state for monotonic ULID within this isolate. */
let lastTime = -1;
let lastRandom = new Uint8Array(RANDOM_LEN);

function encodeTime(time: number): string {
  let t = time;
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[bytes[i]! & 31];
  }
  return out;
}

/** Increment the 80-bit random portion (as 16 base32 digits) in place. */
function incrementRandom(bytes: Uint8Array): void {
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const next = (bytes[i]! + 1) & 31;
    bytes[i] = next;
    if (next !== 0) return;
  }
  throw new Error("ULID random overflow within the same millisecond");
}

function fillRandom(bytes: Uint8Array): void {
  crypto.getRandomValues(bytes);
  for (let i = 0; i < RANDOM_LEN; i++) {
    bytes[i] = bytes[i]! & 31;
  }
}

/**
 * Generate a monotonic ULID (26 Crockford Base32 chars).
 * Same-millisecond calls increment the random suffix so lexicographic order
 * matches generation order within this isolate.
 */
export function generateUlid(now = Date.now()): string {
  if (now < lastTime) {
    // Clock went backwards — keep advancing from lastTime for monotonicity.
    now = lastTime;
  }

  if (now === lastTime) {
    incrementRandom(lastRandom);
  } else {
    fillRandom(lastRandom);
    lastTime = now;
  }

  return encodeTime(now) + encodeRandom(lastRandom);
}

/** Reset monotonic state. For tests only. */
export function resetUlidStateForTests(): void {
  lastTime = -1;
  lastRandom = new Uint8Array(RANDOM_LEN);
}

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** True if `value` is a 26-char Crockford Base32 ULID (case-insensitive). */
export function isUlid(value: string): boolean {
  return value.length === 26 && ULID_RE.test(value.toUpperCase());
}
