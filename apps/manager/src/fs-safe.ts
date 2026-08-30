import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function ensurePrivateDirectory(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await fs.chmod(target, 0o700);
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWrite(target: string, value: string, mode = 0o600): Promise<void> {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(temporary, mode);
  await fs.rename(temporary, target);
  const directory = await fs.open(path.dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readJson<T>(target: string): Promise<T> {
  return JSON.parse(await fs.readFile(target, "utf8")) as T;
}

export async function sha256File(target: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(target, "r");
  try {
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export function safeLabel(value: string): string {
  const label = value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!label) throw new Error("A non-empty label is required");
  return label.slice(0, 64);
}

export function assertUuid(value: string, field = "node_id"): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
}

export function assertUuid7(value: string, field = "node_id"): void {
  assertUuid(value, field);
  if (value[14]?.toLowerCase() !== "7") throw new Error(`${field} must be a UUIDv7`);
}

export function uuid7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new Error("Invalid UUIDv7 timestamp");
  const bytes = crypto.randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
