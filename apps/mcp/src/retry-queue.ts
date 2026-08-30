import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { uuid7 } from "./ids.js";
import type { JsonObject, RetryEntry } from "./types.js";

const RECORD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function retryKey(recordId: string, targetNode: string): string {
  return `${recordId}\u0000${targetNode}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

interface SpoolEnvelope {
  record: JsonObject;
  pending_targets: string[];
}

interface IdempotencyEntry {
  record_id: string;
  payload_hash: string;
  namespace_hash: string;
  created_at: string;
}

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60_000;
const IDEMPOTENCY_MAX_ENTRIES_PER_NAMESPACE = 10_000;

export class DurableRetryQueue {
  readonly #queuePath: string;
  readonly #recordsDir: string;
  readonly #idempotencyDir: string;
  readonly #lockDir: string;
  #tail: Promise<void> = Promise.resolve();
  #idempotencyWritesSincePrune = 0;

  constructor(stateDir: string) {
    this.#queuePath = join(stateDir, "retry-queue.json");
    this.#recordsDir = join(stateDir, "records");
    this.#idempotencyDir = join(stateDir, "idempotency");
    this.#lockDir = join(stateDir, ".retry-queue.lock");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#recordsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.#idempotencyDir, { recursive: true, mode: 0o700 })
    ]);
    await this.#exclusive(async () => {
      try {
        await access(this.#queuePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicJsonWrite(this.#queuePath, []);
      }
      await this.#reconcileSpool();
      await this.#pruneIdempotencyRegistry();
    });
  }

  async resolveIdempotencyKey(
    key: string,
    namespace: string,
    payloadHash: string,
    requestedRecordId?: string
  ): Promise<string> {
    if (!key || Buffer.byteLength(key, "utf8") > 512) throw new Error("idempotency_key must be 1 to 512 bytes");
    if (requestedRecordId) this.#assertRecordId(requestedRecordId);
    const digest = createHash("sha256").update(namespace).update("\0").update(key).digest("hex");
    const namespaceHash = createHash("sha256").update(namespace).digest("hex");
    const path = join(this.#idempotencyDir, digest.slice(0, 2), `${digest}.json`);
    return this.#exclusive(async () => {
      let existing: IdempotencyEntry | undefined;
      try {
        existing = JSON.parse(await readFile(path, "utf8")) as IdempotencyEntry;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let active = false;
      if (existing) {
        try {
          await access(this.#recordPath(existing.record_id));
          active = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (existing && (active || Date.now() - Date.parse(existing.created_at) <= IDEMPOTENCY_TTL_MS)) {
        if (existing.payload_hash !== payloadHash) throw new Error("idempotency_key was already used with a different payload");
        if (requestedRecordId && existing.record_id !== requestedRecordId) throw new Error("record_id conflicts with idempotency_key");
        return existing.record_id;
      }
      const recordId = requestedRecordId ?? uuid7();
      await atomicJsonWrite(path, {
        record_id: recordId,
        payload_hash: payloadHash,
        namespace_hash: namespaceHash,
        created_at: new Date().toISOString()
      } satisfies IdempotencyEntry);
      this.#idempotencyWritesSincePrune += 1;
      if (this.#idempotencyWritesSincePrune >= 256) {
        await this.#pruneIdempotencyRegistry();
        this.#idempotencyWritesSincePrune = 0;
      }
      return recordId;
    });
  }

  async enqueueRecord(record: JsonObject, targets: string[]): Promise<JsonObject> {
    const recordId = String(record.record_id ?? "");
    this.#assertRecordId(recordId);
    return this.#exclusive(async () => {
      const recordPath = this.#recordPath(recordId);
      let existingText: string | undefined;
      try {
        existingText = await readFile(recordPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let persistedRecord = record;
      if (existingText === undefined) {
        await atomicJsonWrite(recordPath, { record: persistedRecord, pending_targets: targets } satisfies SpoolEnvelope);
      } else {
        const existing = JSON.parse(existingText) as SpoolEnvelope;
        const { origin_scopes: existingScopesValue, ...existingImmutable } = existing.record;
        const { origin_scopes: requestedScopesValue, ...requestedImmutable } = record;
        if (canonicalJson(existingImmutable) !== canonicalJson(requestedImmutable)) throw new Error("record spool collision");
        const existingScopes = existingScopesValue && typeof existingScopesValue === "object"
          ? existingScopesValue as JsonObject
          : {};
        const requestedScopes = requestedScopesValue && typeof requestedScopesValue === "object"
          ? requestedScopesValue as JsonObject
          : {};
        persistedRecord = { ...existing.record, origin_scopes: { ...requestedScopes, ...existingScopes } };
        const pendingTargets = [...new Set([...existing.pending_targets, ...targets])];
        if (pendingTargets.length !== existing.pending_targets.length || JSON.stringify(persistedRecord) !== JSON.stringify(existing.record)) {
          await atomicJsonWrite(recordPath, { record: persistedRecord, pending_targets: pendingTargets } satisfies SpoolEnvelope);
        }
      }

      const entries = await this.#readQueue();
      const existingKeys = new Set(entries.map((entry) => retryKey(entry.record_id, entry.target_node)));
      const now = new Date().toISOString();
      for (const target of targets) {
        const key = retryKey(recordId, target);
        if (!existingKeys.has(key)) {
          entries.push({
            record_id: recordId,
            target_node: target,
            attempts: 0,
            next_attempt_at: now,
            created_at: now,
            updated_at: now
          });
        }
      }
      await atomicJsonWrite(this.#queuePath, entries);
      return persistedRecord;
    });
  }

  async markPending(recordId: string, targetNode: string, errorCode: string): Promise<void> {
    await this.#exclusive(async () => {
      const entries = await this.#readQueue();
      const entry = entries.find((candidate) => candidate.record_id === recordId && candidate.target_node === targetNode);
      if (!entry) throw new Error("retry entry disappeared");
      entry.attempts += 1;
      entry.last_error_code = errorCode;
      entry.updated_at = new Date().toISOString();
      const delayMs = Math.min(300_000, 2_000 * 2 ** Math.min(entry.attempts - 1, 8));
      entry.next_attempt_at = new Date(Date.now() + delayMs).toISOString();
      await atomicJsonWrite(this.#queuePath, entries);
    });
  }

  async resolve(recordId: string, targetNode: string): Promise<void> {
    await this.#exclusive(async () => {
      const recordPath = this.#recordPath(recordId);
      try {
        const envelope = JSON.parse(await readFile(recordPath, "utf8")) as SpoolEnvelope;
        const pendingTargets = envelope.pending_targets.filter((target) => target !== targetNode);
        if (pendingTargets.length === 0) await rm(recordPath, { force: true });
        else await atomicJsonWrite(recordPath, { record: envelope.record, pending_targets: pendingTargets } satisfies SpoolEnvelope);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const entries = await this.#readQueue();
      const remaining = entries.filter((entry) => !(entry.record_id === recordId && entry.target_node === targetNode));
      await atomicJsonWrite(this.#queuePath, remaining);
    });
  }

  async list(options: { targets?: string[]; limit: number; force: boolean }): Promise<RetryEntry[]> {
    return this.#exclusive(async () => {
      const now = Date.now();
      const targets = options.targets ? new Set(options.targets) : undefined;
      const entries = await this.#readQueue();
      return entries
        .filter((entry) => !targets || targets.has(entry.target_node))
        .filter((entry) => options.force || Date.parse(entry.next_attempt_at) <= now)
        .sort((left, right) => left.next_attempt_at.localeCompare(right.next_attempt_at))
        .slice(0, options.limit);
    });
  }

  async readRecord(recordId: string): Promise<JsonObject | undefined> {
    this.#assertRecordId(recordId);
    try {
      const envelope = JSON.parse(await readFile(this.#recordPath(recordId), "utf8")) as SpoolEnvelope;
      return envelope.record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async count(): Promise<number> {
    return this.#exclusive(async () => (await this.#readQueue()).length);
  }

  async #readQueue(): Promise<RetryEntry[]> {
    const decoded = JSON.parse(await readFile(this.#queuePath, "utf8")) as unknown;
    if (!Array.isArray(decoded)) throw new Error("retry queue is corrupt");
    return decoded as RetryEntry[];
  }

  async #reconcileSpool(): Promise<void> {
    const entries = await this.#readQueue();
    const byKey = new Map(entries.map((entry) => [retryKey(entry.record_id, entry.target_node), entry]));
    const validKeys = new Set<string>();
    const now = new Date().toISOString();
    for (const filename of await readdir(this.#recordsDir)) {
      if (!filename.endsWith(".json")) continue;
      const recordId = filename.slice(0, -5);
      this.#assertRecordId(recordId);
      const envelope = JSON.parse(await readFile(join(this.#recordsDir, filename), "utf8")) as SpoolEnvelope;
      if (String(envelope.record.record_id ?? "") !== recordId || !Array.isArray(envelope.pending_targets)) {
        throw new Error("record spool is corrupt");
      }
      for (const targetNode of envelope.pending_targets) {
        const key = retryKey(recordId, targetNode);
        validKeys.add(key);
        if (!byKey.has(key)) {
          byKey.set(key, {
            record_id: recordId,
            target_node: targetNode,
            attempts: 0,
            next_attempt_at: now,
            created_at: now,
            updated_at: now,
            last_error_code: "recovered_after_restart"
          });
        }
      }
    }
    const reconciled = [...byKey.entries()]
      .filter(([key]) => validKeys.has(key))
      .map(([, entry]) => entry);
    if (JSON.stringify(reconciled) !== JSON.stringify(entries)) {
      await atomicJsonWrite(this.#queuePath, reconciled);
    }
  }

  async #pruneIdempotencyRegistry(): Promise<void> {
    const activeRecordIds = new Set((await readdir(this.#recordsDir))
      .filter((filename) => filename.endsWith(".json"))
      .map((filename) => filename.slice(0, -5)));
    const entries: Array<{ path: string; createdAt: number; recordId: string; namespaceHash: string }> = [];
    for (const shard of await readdir(this.#idempotencyDir, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const shardPath = join(this.#idempotencyDir, shard.name);
      for (const file of await readdir(shardPath, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        const path = join(shardPath, file.name);
        try {
          const decoded = JSON.parse(await readFile(path, "utf8")) as IdempotencyEntry;
          const createdAt = Date.parse(decoded.created_at);
          const active = activeRecordIds.has(decoded.record_id);
          if (!active && (!Number.isFinite(createdAt) || Date.now() - createdAt > IDEMPOTENCY_TTL_MS)) {
            await rm(path, { force: true });
          } else {
            entries.push({
              path,
              createdAt,
              recordId: decoded.record_id,
              namespaceHash: decoded.namespace_hash ?? "legacy"
            });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const byNamespace = new Map<string, typeof entries>();
    for (const entry of entries) {
      const grouped = byNamespace.get(entry.namespaceHash) ?? [];
      grouped.push(entry);
      byNamespace.set(entry.namespaceHash, grouped);
    }
    for (const grouped of byNamespace.values()) {
      const removable = grouped.filter((entry) => !activeRecordIds.has(entry.recordId));
      const excess = grouped.length - IDEMPOTENCY_MAX_ENTRIES_PER_NAMESPACE;
      if (excess <= 0) continue;
      removable.sort((left, right) => left.createdAt - right.createdAt);
      await Promise.all(removable.slice(0, excess).map((entry) => rm(entry.path, { force: true })));
    }
  }

  #recordPath(recordId: string): string {
    this.#assertRecordId(recordId);
    return join(this.#recordsDir, `${recordId}.json`);
  }

  #assertRecordId(recordId: string): void {
    if (!RECORD_ID_PATTERN.test(recordId)) throw new Error("invalid record id");
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      releaseFileLock = await this.#acquireFileLock();
      return await operation();
    } finally {
      try {
        await releaseFileLock?.();
      } finally {
        release();
      }
    }
  }

  async #acquireFileLock(): Promise<() => Promise<void>> {
    const owner = randomUUID();
    const startedAt = Date.now();
    while (true) {
      let directoryCreated = false;
      try {
        await mkdir(this.#lockDir, { mode: 0o700 });
        directoryCreated = true;
        await atomicJsonWrite(join(this.#lockDir, "owner.json"), {
          owner,
          pid: process.pid,
          created_at: new Date().toISOString()
        });
        return async () => {
          try {
            const current = JSON.parse(await readFile(join(this.#lockDir, "owner.json"), "utf8")) as { owner?: unknown };
            if (current.owner === owner) await rm(this.#lockDir, { recursive: true, force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        if (directoryCreated) {
          await rm(this.#lockDir, { recursive: true, force: true });
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(this.#lockDir);
          const lockOwner: { pid?: unknown } = await readFile(join(this.#lockDir, "owner.json"), "utf8")
            .then((value) => JSON.parse(value) as { pid?: unknown })
            .catch(() => ({}));
          const ownerIsDead = typeof lockOwner.pid === "number" && !processIsAlive(lockOwner.pid);
          if (ownerIsDead || Date.now() - lockStat.mtimeMs > 5_000) {
            const stalePath = `${this.#lockDir}.stale.${randomUUID()}`;
            try {
              await rename(this.#lockDir, stalePath);
              await rm(stalePath, { recursive: true, force: true });
            } catch (renameError) {
              if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
            }
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
          continue;
        }
        if (Date.now() - startedAt > 30_000) throw new Error("timed out waiting for retry queue lock");
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)));
      }
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
