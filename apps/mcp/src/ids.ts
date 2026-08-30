import { randomBytes } from "node:crypto";

const RANDOM_MASK = (1n << 74n) - 1n;
let lastTimestampMs = -1;
let lastRandom = 0n;

function freshRandom74(): bigint {
  const bytes = randomBytes(10);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value & RANDOM_MASK;
}

function hex(value: bigint, width: number): string {
  return value.toString(16).padStart(width, "0");
}

/** Generate a process-monotonic UUIDv7 value following RFC 9562. */
export function uuid7(): string {
  let nowMs = Date.now();
  if (nowMs > lastTimestampMs) {
    lastTimestampMs = nowMs;
    lastRandom = freshRandom74();
  } else {
    nowMs = lastTimestampMs;
    lastRandom = (lastRandom + 1n) & RANDOM_MASK;
    if (lastRandom === 0n) {
      lastTimestampMs += 1;
      nowMs = lastTimestampMs;
    }
  }

  const timestamp = BigInt(nowMs) & ((1n << 48n) - 1n);
  const randA = (lastRandom >> 62n) & 0xfffn;
  const randB = lastRandom & ((1n << 62n) - 1n);
  const value = (timestamp << 80n) | (0x7n << 76n) | (randA << 64n) | (0x2n << 62n) | randB;
  const encoded = hex(value, 32);
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
}
