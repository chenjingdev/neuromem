import { createHash } from "node:crypto";

import { CoreClient, CoreRequestError } from "./core-client.js";
import { uuid7 } from "./ids.js";
import { DurableRetryQueue } from "./retry-queue.js";
import type {
  CoreNodeConfig,
  DeliveryStatus,
  FederatedError,
  FederatedResult,
  JsonObject,
  MemoryScope,
  RetryEntry,
  RouterConfig
} from "./types.js";

interface MemoryRecordInput extends JsonObject {
  workspace_id: string;
  project_id: string;
  session_id: string;
  author_key: string;
  author_kind: "human" | "agent" | "automation" | "service";
  content: string;
  record_id?: string;
  idempotency_key?: string;
  targets?: string[];
}

interface RecallInput extends JsonObject {
  workspace_id: string;
  project_id: string;
  query: string;
  targets?: string[];
  limit?: number;
  include_general?: boolean;
  include_federated?: boolean;
}

interface StoredWrite extends JsonObject {
  record_id: string;
  workspace_id: string;
  project_id: string;
  session_id: string;
  record: JsonObject;
  origin_scopes?: Record<string, MemoryScope>;
}

interface RankedItem {
  item: JsonObject;
  nodeId: string;
  nodeOrder: number;
  rank: number;
}

const MAX_SERIALIZED_RESULT_BYTES = 960_000;
const MAX_SERIALIZED_ITEM_BYTES = 512 * 1_024;

class InvalidCoreResponseError extends Error {}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function objectItems(value: unknown, memoryKind?: string): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asObject)
    .filter((item): item is JsonObject => Boolean(item))
    .map((item) => memoryKind ? { ...item, memory_kind: memoryKind } : item);
}

function extractRecallItems(payload: unknown, include: ReadonlySet<"records" | "claims">): JsonObject[] {
  const object = asObject(payload);
  if (!object || !Array.isArray(object.records) || !Array.isArray(object.claims) || !Array.isArray(object.record_snippets)) {
    throw new InvalidCoreResponseError("invalid recall response");
  }
  const snippets = objectItems(object.record_snippets);
  const snippetsByRecord = new Map<string, JsonObject[]>();
  for (const snippet of snippets) {
    if (!Array.isArray(snippet.matched_record_ids)) continue;
    for (const recordId of snippet.matched_record_ids) {
      if (typeof recordId !== "string") continue;
      const attached = snippetsByRecord.get(recordId) ?? [];
      attached.push(snippet);
      snippetsByRecord.set(recordId, attached);
    }
  }
  const records = include.has("records")
    ? objectItems(object.records, "record").map((record) => {
      const matches = typeof record.record_id === "string" ? snippetsByRecord.get(record.record_id) ?? [] : [];
      if (matches.length === 0) return record;
      const contextById = new Map<string, JsonObject>();
      for (const snippet of matches) {
        const snippetRecords = objectItems(snippet.records);
        const targetIndex = snippetRecords.findIndex((candidate) => candidate.id === record.record_id);
        const localContext = targetIndex >= 0
          ? snippetRecords.slice(Math.max(0, targetIndex - 2), targetIndex + 3)
          : snippetRecords.slice(0, 5);
        for (const contextRecord of localContext) {
          const key = typeof contextRecord.id === "string"
            ? contextRecord.id
            : createHash("sha256").update(JSON.stringify(contextRecord)).digest("hex");
          const content = typeof contextRecord.content === "string" ? contextRecord.content : undefined;
          contextById.set(key, content && Buffer.byteLength(content, "utf8") > 16 * 1_024
            ? { ...contextRecord, content: truncateUtf8(content, 16 * 1_024), content_truncated: true }
            : contextRecord);
        }
      }
      const primarySnippet = matches[0]!;
      const snippetRef = createHash("sha256").update(canonicalJson(primarySnippet)).digest("hex");
      return {
        ...record,
        record_snippet: {
          snippet_ref: snippetRef,
          session_id: primarySnippet.session_id,
          matched_record_ids: primarySnippet.matched_record_ids
        },
        context_records: [...contextById.values()]
      };
    })
    : [];
  return [
    ...records,
    ...(include.has("claims") ? objectItems(object.claims, "claim") : [])
  ];
}

function extractContainer(payload: unknown): JsonObject[] {
  const object = asObject(payload);
  if (!object) throw new InvalidCoreResponseError("invalid Core response");
  return [object];
}

function requireContainerArrays(...keys: string[]): (payload: unknown) => JsonObject[] {
  return (payload) => {
    const object = asObject(payload);
    if (!object || keys.some((key) => !Array.isArray(object[key]))) {
      throw new InvalidCoreResponseError("invalid Core response");
    }
    return [object];
  };
}

function extractRecordContext(payload: unknown): JsonObject[] {
  const object = asObject(payload);
  if (!object || typeof object.target_record_id !== "string" || !Array.isArray(object.records)) {
    throw new InvalidCoreResponseError("invalid record context response");
  }
  return [object];
}

function extractClaimEvidence(payload: unknown): JsonObject[] {
  const object = asObject(payload);
  if (!object || !asObject(object.claim) || !Array.isArray(object.evidence)) {
    throw new InvalidCoreResponseError("invalid claim evidence response");
  }
  return [object];
}

function contentHash(item: JsonObject): string | undefined {
  if (typeof item.content_hash === "string" && item.content_hash) return item.content_hash;
  if (typeof item.content !== "string") return undefined;
  return createHash("sha256").update(item.content.trim().replace(/\s+/g, " ")).digest("hex");
}

function dedupeKey(item: JsonObject, nodeId: string, fallback: string): string {
  if (typeof item.record_id === "string" && item.record_id) return `record:${item.record_id}`;
  if (typeof item.claim_id === "string" && item.claim_id) return `claim:${item.claim_id}`;
  if (typeof item.result_id === "string" && item.result_id) return `result:${nodeId}:${item.result_id}`;
  const hash = contentHash(item);
  const kind = typeof item.memory_kind === "string" ? item.memory_kind : "content";
  return hash ? `${kind}:${nodeId}:${hash}` : fallback;
}

function optionalFields(input: JsonObject, keys: string[]): JsonObject {
  const result: JsonObject = {};
  for (const key of keys) {
    if (input[key] !== undefined) result[key] = input[key];
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return value;
  return new TextDecoder().decode(encoded.subarray(0, maximumBytes));
}

function compactItem(item: JsonObject): JsonObject {
  const compact: JsonObject = {};
  for (const key of [
    "origin_node", "origin_nodes", "origin_scope", "logical_scope", "memory_kind", "record_id", "claim_id", "snippet_ref",
    "result_id", "session_id", "matched_record_ids", "content_hash", "status", "derivation_method", "rank", "rrf_score", "created_at"
  ]) {
    if (item[key] !== undefined) compact[key] = item[key];
  }
  if (typeof item.content === "string") compact.content = truncateUtf8(item.content, 64 * 1_024);
  if (typeof item.matched_content === "string") compact.matched_content = truncateUtf8(item.matched_content, 32 * 1_024);
  compact.truncated = true;
  compact.original_bytes = serializedBytes(item);
  return compact;
}

function uuid7OccurredAt(recordId: string): string {
  const timestampHex = recordId.replaceAll("-", "").slice(0, 12);
  return new Date(Number(BigInt(`0x${timestampHex}`))).toISOString();
}

export class FederatedMemoryRouter {
  readonly #clients: Map<string, CoreClient>;
  readonly #nodes: Map<string, CoreNodeConfig>;
  readonly #defaultReadTargets: string[];
  readonly #defaultWriteTargets: string[];
  readonly #queue: DurableRetryQueue;
  readonly #rrfK: number;
  readonly #retryIntervalMs: number;
  readonly #ready: Promise<void>;
  #retryTimer?: NodeJS.Timeout;
  #drainPromise?: Promise<{ deliveries: Record<string, DeliveryStatus>; remaining: number }>;
  #retryWorkerTask?: Promise<void>;

  constructor(config: RouterConfig) {
    if (config.nodes.length === 0) throw new Error("router requires at least one node");
    const tokenless = config.nodes.find((node) => !node.token || Buffer.byteLength(node.token, "utf8") < 32);
    if (tokenless) throw new Error(`node '${tokenless.id}' requires a Core token of at least 32 bytes`);
    this.#nodes = new Map(config.nodes.map((node) => [node.id, node]));
    this.#clients = new Map(config.nodes.map((node) => [
      node.id,
      new CoreClient(node, config.requestTimeoutMs ?? 120_000, config.maxCoreResponseBytes ?? 64 * 1_048_576)
    ]));
    const fallback = this.#nodes.has("personal") ? ["personal"] : [config.nodes[0]!.id];
    this.#defaultReadTargets = config.defaultReadTargets ?? fallback;
    this.#defaultWriteTargets = config.defaultWriteTargets ?? fallback;
    this.#queue = new DurableRetryQueue(config.stateDir);
    this.#rrfK = config.rrfK ?? 60;
    this.#retryIntervalMs = config.retryIntervalMs ?? 30_000;
    this.#ready = this.#queue.initialize();
    this.#selectTargets(this.#defaultReadTargets, []);
    this.#selectTargets(this.#defaultWriteTargets, []);
  }

  configuredNodes(): string[] {
    return [...this.#nodes.keys()];
  }

  async ready(): Promise<void> {
    await this.#ready;
  }

  targetsFor(target: "personal" | "company" | "both" | undefined): string[] | undefined {
    if (target === undefined) return undefined;
    const requested = target === "both" ? ["personal", "company"] : [target];
    const missing = requested.filter((nodeId) => !this.#nodes.has(nodeId));
    if (missing.length > 0) {
      throw new Error(`target '${target}' is unavailable; missing node '${missing[0]}'`);
    }
    return requested;
  }

  #scopeFor(target: string, logicalScope: MemoryScope): MemoryScope {
    const mapped = this.#nodes.get(target)?.scopeMap?.[logicalScope.project_id.toLowerCase()];
    return mapped ?? logicalScope;
  }

  startRetryWorker(): void {
    if (this.#retryTimer) return;
    this.#scheduleRetry({ force: true, limit: 100 });
    this.#retryTimer = setInterval(() => {
      this.#scheduleRetry({ force: false, limit: 100 });
    }, this.#retryIntervalMs);
    this.#retryTimer.unref();
  }

  async stopRetryWorker(): Promise<void> {
    if (this.#retryTimer) clearInterval(this.#retryTimer);
    this.#retryTimer = undefined;
    await this.#retryWorkerTask;
    await this.#drainPromise;
  }

  async close(): Promise<void> {
    await this.#ready.catch(() => undefined);
    await this.stopRetryWorker();
  }

  #scheduleRetry(options: { force: boolean; limit: number }): void {
    if (this.#retryWorkerTask) return;
    const task = this.retryPending(options).then(() => undefined, () => undefined);
    const tracked = task.finally(() => {
      if (this.#retryWorkerTask === tracked) this.#retryWorkerTask = undefined;
    });
    this.#retryWorkerTask = tracked;
  }

  async memoryRecord(input: MemoryRecordInput): Promise<{
    record_id: string;
    deliveries: Record<string, DeliveryStatus & {
      origin_node: string;
      origin_scope: MemoryScope;
      logical_scope: MemoryScope;
    }>;
  }> {
    await this.#ready;
    const targets = this.#selectTargets(input.targets, this.#defaultWriteTargets);
    const suppliedRecordId = typeof input.record_id === "string" ? input.record_id.toLowerCase() : undefined;
    if (suppliedRecordId && !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedRecordId)) {
      throw new Error("record_id must be a UUIDv7");
    }
    const callerFields: JsonObject = {
      author_key: input.author_key,
      author_name: typeof input.author_name === "string" ? input.author_name : input.author_key,
      author_kind: input.author_kind,
      kind: typeof input.kind === "string" ? input.kind : "message",
      content: input.content,
      source_app: typeof input.source_app === "string" ? input.source_app : "neuromem-mcp",
      metadata: input.metadata ?? {},
      occurred_at: typeof input.occurred_at === "string" ? input.occurred_at : null
    };
    const idempotencyKey = typeof input.idempotency_key === "string" ? input.idempotency_key : undefined;
    const idempotencyNamespace = `${input.workspace_id}:${input.project_id}:${input.session_id}`;
    const payloadHash = createHash("sha256").update(canonicalJson(callerFields)).digest("hex");
    const recordId = idempotencyKey
      ? await this.#queue.resolveIdempotencyKey(idempotencyKey, idempotencyNamespace, payloadHash, suppliedRecordId)
      : suppliedRecordId ?? uuid7();
    const record: JsonObject = {
      id: recordId,
      ...callerFields,
      occurred_at: typeof input.occurred_at === "string" ? input.occurred_at : uuid7OccurredAt(recordId)
    };
    const logicalScope = { workspace_id: input.workspace_id, project_id: input.project_id };
    const originScopes = Object.fromEntries(targets.map((target) => [target, this.#scopeFor(target, logicalScope)]));
    const write: StoredWrite = {
      record_id: recordId,
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      session_id: input.session_id,
      record,
      origin_scopes: originScopes
    };
    const queuedWrite = await this.#queue.enqueueRecord(write, targets) as StoredWrite;
    const statuses = await Promise.all(targets.map(async (target) => {
      const originScope = queuedWrite.origin_scopes?.[target] ?? originScopes[target]!;
      return [
        target,
        {
          origin_node: target,
          origin_scope: originScope,
          logical_scope: logicalScope,
          ...await this.#deliver(queuedWrite, target)
        }
      ] as const;
    }));
    return { record_id: recordId, deliveries: Object.fromEntries(statuses) };
  }

  async recall(input: RecallInput, include: Array<"records" | "claims">): Promise<FederatedResult> {
    const targets = this.#selectTargets(input.targets, this.#defaultReadTargets);
    const limit = this.#limit(input.limit);
    const body: JsonObject = {
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      query: input.query,
      include,
      limit,
      ...optionalFields(input, ["session_id", "after", "before", "include_general", "include_federated"])
    };
    const included = new Set(include);
    return this.#federated(
      "POST",
      "/v1/recall",
      targets,
      limit,
      body,
      undefined,
      (payload) => extractRecallItems(payload, included),
      { workspace_id: input.workspace_id, project_id: input.project_id }
    );
  }

  async getRecordContext(workspaceId: string, projectId: string, recordId: string, targets?: string[]): Promise<FederatedResult> {
    return this.#federated(
      "GET",
      `/v1/records/${encodeURIComponent(recordId)}/context`,
      this.#selectTargets(targets, this.#defaultReadTargets),
      50,
      undefined,
      { workspace_id: workspaceId, project_id: projectId },
      extractRecordContext,
      { workspace_id: workspaceId, project_id: projectId }
    );
  }

  async getClaimEvidence(workspaceId: string, projectId: string, claimId: string, targets?: string[]): Promise<FederatedResult> {
    return this.#federated(
      "GET",
      `/v1/claims/${encodeURIComponent(claimId)}/evidence`,
      this.#selectTargets(targets, this.#defaultReadTargets),
      50,
      undefined,
      { workspace_id: workspaceId, project_id: projectId },
      extractClaimEvidence,
      { workspace_id: workspaceId, project_id: projectId }
    );
  }

  async wikiRead(workspaceId: string, projectId: string, targets?: string[]): Promise<FederatedResult> {
    return this.#federated(
      "GET",
      (scope) => `/v1/projects/${encodeURIComponent(scope.project_id)}/wiki`,
      this.#selectTargets(targets, this.#defaultReadTargets),
      50,
      undefined,
      { workspace_id: workspaceId, project_id: projectId },
      requireContainerArrays("sections"),
      { workspace_id: workspaceId, project_id: projectId }
    );
  }

  async graphRead(workspaceId: string, projectId: string, targets?: string[]): Promise<FederatedResult> {
    return this.#federated(
      "GET",
      (scope) => `/v1/projects/${encodeURIComponent(scope.project_id)}/graph`,
      this.#selectTargets(targets, this.#defaultReadTargets),
      50,
      undefined,
      { workspace_id: workspaceId, project_id: projectId },
      requireContainerArrays("nodes", "edges"),
      { workspace_id: workspaceId, project_id: projectId }
    );
  }

  async representationRead(
    workspaceId: string,
    projectId: string,
    peerId: string,
    includeGeneral = true,
    targets?: string[]
  ): Promise<FederatedResult> {
    return this.#federated(
      "GET",
      `/v1/peers/${encodeURIComponent(peerId)}/representation`,
      this.#selectTargets(targets, this.#defaultReadTargets),
      50,
      undefined,
      { workspace_id: workspaceId, project_id: projectId, include_general: includeGeneral },
      extractContainer,
      { workspace_id: workspaceId, project_id: projectId }
    );
  }

  async peerCardRead(
    workspaceId: string,
    projectId: string,
    peerId: string,
    includeGeneral = true,
    targets?: string[]
  ): Promise<FederatedResult> {
    return this.#federated(
      "GET",
      `/v1/peers/${encodeURIComponent(peerId)}/card`,
      this.#selectTargets(targets, this.#defaultReadTargets),
      50,
      undefined,
      { workspace_id: workspaceId, project_id: projectId, include_general: includeGeneral },
      extractContainer,
      { workspace_id: workspaceId, project_id: projectId }
    );
  }

  async sessionContextRead(
    workspaceId: string,
    projectId: string,
    sessionId: string,
    includeGeneral = true,
    targets?: string[]
  ): Promise<FederatedResult> {
    return this.#federated(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/context`,
      this.#selectTargets(targets, this.#defaultReadTargets),
      50,
      undefined,
      { workspace_id: workspaceId, project_id: projectId, include_general: includeGeneral },
      extractContainer,
      { workspace_id: workspaceId, project_id: projectId }
    );
  }

  async dynamicContext(input: JsonObject & {
    workspace_id: string;
    project_id: string;
    query: string;
    targets?: string[];
  }): Promise<FederatedResult> {
    const targets = this.#selectTargets(input.targets, this.#defaultReadTargets);
    const body = {
      ...input,
      targets: undefined,
      include_general: input.include_general ?? true,
      include_federated: input.include_federated ?? false
    };
    return this.#federated(
      "POST", "/v1/context", targets, 50, body, undefined, extractContainer,
      { workspace_id: input.workspace_id, project_id: input.project_id }
    );
  }

  async dialecticChat(input: JsonObject & {
    workspace_id: string;
    project_id: string;
    query: string;
    targets?: string[];
  }): Promise<FederatedResult> {
    const targets = this.#selectTargets(input.targets, this.#defaultReadTargets);
    const body = {
      ...input,
      targets: undefined,
      include_general: input.include_general ?? true,
      include_federated: input.include_federated ?? false
    };
    return this.#federated(
      "POST", "/v1/chat", targets, 50, body, undefined, extractContainer,
      { workspace_id: input.workspace_id, project_id: input.project_id }
    );
  }

  async scheduleDream(
    workspaceId: string,
    projectId: string,
    input: JsonObject,
    targets?: string[]
  ): Promise<FederatedResult> {
    return this.#federated(
      "POST", "/v1/dreams", this.#selectTargets(targets, this.#defaultWriteTargets), 50,
      { ...input, workspace_id: workspaceId, project_id: projectId }, undefined, extractContainer,
      { workspace_id: workspaceId, project_id: projectId }
    );
  }

  async createTransferRequest(
    workspaceId: string,
    projectId: string,
    input: JsonObject,
    targets?: string[]
  ): Promise<FederatedResult> {
    return this.#federated(
      "POST", "/v1/transfer-requests", this.#selectTargets(targets, this.#defaultWriteTargets), 50,
      { ...input, source_workspace_id: workspaceId, source_project_id: projectId }, undefined, extractContainer,
      { workspace_id: workspaceId, project_id: projectId }
    );
  }

  async retryPending(options: { targets?: string[]; limit?: number; force?: boolean } = {}): Promise<{
    deliveries: Record<string, DeliveryStatus>;
    remaining: number;
  }> {
    await this.#ready;
    if (this.#drainPromise) return this.#drainPromise;
    this.#drainPromise = this.#drain(options);
    try {
      return await this.#drainPromise;
    } finally {
      this.#drainPromise = undefined;
    }
  }

  async #drain(options: { targets?: string[]; limit?: number; force?: boolean }): Promise<{
    deliveries: Record<string, DeliveryStatus>;
    remaining: number;
  }> {
    const targets = options.targets ? this.#selectTargets(options.targets, []) : undefined;
    const entries = await this.#queue.list({ targets, limit: this.#retryLimit(options.limit ?? 100), force: options.force ?? true });
    const delivered = await Promise.all(entries.map(async (entry) => this.#retryEntry(entry)));
    return {
      deliveries: Object.fromEntries(delivered.map(({ key, status }) => [key, status])),
      remaining: await this.#queue.count()
    };
  }

  async #retryEntry(entry: RetryEntry): Promise<{ key: string; status: DeliveryStatus }> {
    const key = `${entry.record_id}:${entry.target_node}`;
    const write = await this.#queue.readRecord(entry.record_id) as StoredWrite | undefined;
    if (!write) {
      await this.#queue.resolve(entry.record_id, entry.target_node);
      return { key, status: { status: "failed", error_code: "spool_missing" } };
    }
    if (!this.#clients.has(entry.target_node)) {
      await this.#queue.markPending(entry.record_id, entry.target_node, "target_unavailable");
      return { key, status: { status: "pending", error_code: "target_unavailable" } };
    }
    return { key, status: await this.#deliver(write, entry.target_node) };
  }

  async #deliver(write: StoredWrite, target: string): Promise<DeliveryStatus> {
    const client = this.#clients.get(target);
    if (!client) return { status: "failed", error_code: "unknown_target" };
    try {
      await this.#postBatch(client, write, target);
      await this.#queue.resolve(write.record_id, target);
      return { status: "stored" };
    } catch (error) {
      if (error instanceof CoreRequestError && error.httpStatus === 404) {
        const creation = await this.#createMissingSession(client, write, target);
        if (creation.created) {
          try {
            await this.#postBatch(client, write, target);
            await this.#queue.resolve(write.record_id, target);
            return { status: "stored" };
          } catch (retryError) {
            return this.#finishDeliveryError(write, target, retryError);
          }
        }
        if (creation.error instanceof CoreRequestError && creation.error.retryable) {
          return this.#finishDeliveryError(write, target, creation.error);
        }
      }
      return this.#finishDeliveryError(write, target, error);
    }
  }

  async #postBatch(client: CoreClient, write: StoredWrite, target: string): Promise<void> {
    const scope = write.origin_scopes?.[target]
      ?? this.#scopeFor(target, { workspace_id: write.workspace_id, project_id: write.project_id });
    await client.request("POST", "/v1/records:batch", {
      body: {
        workspace_id: scope.workspace_id,
        project_id: scope.project_id,
        session_id: write.session_id,
        records: [write.record]
      },
      idempotencyKey: write.record_id,
      expectJson: false
    });
  }

  async #createMissingSession(
    client: CoreClient,
    write: StoredWrite,
    target: string
  ): Promise<{ created: boolean; error?: unknown }> {
    const scope = write.origin_scopes?.[target]
      ?? this.#scopeFor(target, { workspace_id: write.workspace_id, project_id: write.project_id });
    const sourceApp = typeof write.record.source_app === "string" && write.record.source_app
      ? write.record.source_app
      : "Agent session";
    try {
      const response = await client.request(
        "POST",
        `/v1/workspaces/${encodeURIComponent(scope.workspace_id)}/projects/${encodeURIComponent(scope.project_id)}/sessions`,
        {
          body: {
            id: write.session_id,
            external_key: write.session_id,
            name: sourceApp
          }
        }
      );
      const created = asObject(response);
      return { created: created?.id === write.session_id };
    } catch (error) {
      return { created: false, error };
    }
  }

  async #finishDeliveryError(write: StoredWrite, target: string, error: unknown): Promise<DeliveryStatus> {
    if (error instanceof CoreRequestError) {
      if (error.retryable) {
        await this.#queue.markPending(write.record_id, target, error.code);
        return {
          status: "pending",
          error_code: error.code,
          ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus })
        };
      }
      await this.#queue.resolve(write.record_id, target);
      return {
        status: "failed",
        error_code: error.code,
        ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus })
      };
    }
    await this.#queue.markPending(write.record_id, target, "internal_error");
    return { status: "pending", error_code: "internal_error" };
  }

  async #federated(
    method: "GET" | "POST",
    path: string | ((originScope: MemoryScope) => string),
    targets: string[],
    limit: number,
    body?: JsonObject,
    query?: Record<string, string | number | boolean | undefined>,
    extractor: (payload: unknown) => JsonObject[] = extractContainer,
    logicalScope?: MemoryScope
  ): Promise<FederatedResult> {
    await this.#ready;
    const responses = await Promise.all(targets.map(async (target, nodeOrder) => {
      const client = this.#clients.get(target)!;
      const originScope = logicalScope ? this.#scopeFor(target, logicalScope) : undefined;
      const scopedBody = body && originScope && ("workspace_id" in body || "project_id" in body)
        ? { ...body, workspace_id: originScope.workspace_id, project_id: originScope.project_id }
        : body;
      const scopedQuery = query && originScope
        ? {
            ...query,
            ...(query.workspace_id === undefined ? {} : { workspace_id: originScope.workspace_id }),
            ...(query.project_id === undefined ? {} : { project_id: originScope.project_id })
          }
        : query;
      const scopedPath = typeof path === "function" ? path(originScope ?? logicalScope!) : path;
      try {
        const payload = await client.request(method, scopedPath, { body: scopedBody, query: scopedQuery });
        const items = extractor(payload).map((item) => {
          const snippet = asObject(item.record_snippet);
          return {
            ...item,
            ...(snippet && typeof snippet.snippet_ref === "string"
              ? { record_snippet: { ...snippet, snippet_ref: `${target}:${snippet.snippet_ref}` } }
              : {}),
            ...(originScope ? { origin_scope: originScope } : {}),
            ...(logicalScope ? { logical_scope: logicalScope } : {})
          };
        });
        return { target, nodeOrder, items, payload, originScope };
      } catch (error) {
        const safe = error instanceof CoreRequestError
          ? {
              origin_node: target,
              error_code: error.code,
              ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus }),
              ...(originScope ? { origin_scope: originScope } : {}),
              ...(logicalScope ? { logical_scope: logicalScope } : {})
            }
          : error instanceof InvalidCoreResponseError
            ? {
                origin_node: target,
                error_code: "invalid_core_response",
                ...(originScope ? { origin_scope: originScope } : {}),
                ...(logicalScope ? { logical_scope: logicalScope } : {})
              }
            : {
              origin_node: target,
              error_code: "internal_error",
              ...(originScope ? { origin_scope: originScope } : {}),
              ...(logicalScope ? { logical_scope: logicalScope } : {})
            };
        return { target, nodeOrder, items: [] as JsonObject[], payload: undefined, originScope, error: safe as FederatedError };
      }
    }));

    const ranked: RankedItem[] = [];
    const errors: FederatedError[] = [];
    for (const response of responses) {
      if (response.error) errors.push(response.error);
      response.items.forEach((item, index) => {
        const reportedRank = typeof item.rank === "number" && Number.isInteger(item.rank) && item.rank > 0 ? item.rank : index + 1;
        ranked.push({ item, nodeId: response.target, nodeOrder: response.nodeOrder, rank: reportedRank });
      });
    }
    const embeddingUsedByNode: Record<string, boolean> = {};
    const recordSnippets: JsonObject[] = [];
    for (const response of responses) {
      const payload = asObject(response.payload);
      if (!payload) continue;
      if (typeof payload.embedding_used === "boolean") embeddingUsedByNode[response.target] = payload.embedding_used;
      for (const snippet of objectItems(payload.record_snippets)) {
        recordSnippets.push({
          ...snippet,
          snippet_ref: `${response.target}:${createHash("sha256").update(canonicalJson(snippet)).digest("hex")}`,
          origin_node: response.target,
          ...(response.originScope ? { origin_scope: response.originScope } : {}),
          ...(logicalScope ? { logical_scope: logicalScope } : {})
        });
      }
    }
    return this.#boundFederatedResult({
      results: this.#rrf(ranked, limit),
      errors,
      targets,
      ...(Object.keys(embeddingUsedByNode).length === 0
        ? {}
        : {
            embedding_used: Object.values(embeddingUsedByNode).some(Boolean),
            embedding_used_by_node: embeddingUsedByNode
          }),
      ...(recordSnippets.length > 0 ? { record_snippets: recordSnippets } : {})
    });
  }

  #boundFederatedResult(result: FederatedResult): FederatedResult {
    const sourceResults = result.results;
    const sourceSnippets = result.record_snippets ?? [];
    const { record_snippets: _snippets, ...base } = result;
    const bounded: FederatedResult = { ...base, results: [] };
    let omittedResults = 0;
    let omittedSnippets = 0;
    let snippetCompacted = false;
    for (const raw of sourceResults) {
      const candidate = serializedBytes(raw) <= MAX_SERIALIZED_ITEM_BYTES ? raw : compactItem(raw);
      const next = { ...bounded, results: [...bounded.results, candidate] };
      if (serializedBytes(next) > MAX_SERIALIZED_RESULT_BYTES - 256) {
        omittedResults += 1;
        continue;
      }
      bounded.results.push(candidate);
    }
    const boundedSnippets: JsonObject[] = [];
    for (const raw of sourceSnippets) {
      const candidate = serializedBytes(raw) <= MAX_SERIALIZED_ITEM_BYTES ? raw : compactItem(raw);
      if (candidate !== raw) snippetCompacted = true;
      const next = { ...bounded, record_snippets: [...boundedSnippets, candidate] };
      if (serializedBytes(next) > MAX_SERIALIZED_RESULT_BYTES - 256) {
        omittedSnippets += 1;
        continue;
      }
      boundedSnippets.push(candidate);
    }
    if (boundedSnippets.length > 0) bounded.record_snippets = boundedSnippets;
    if (omittedResults > 0 || omittedSnippets > 0 || snippetCompacted || bounded.results.some((item) => item.truncated === true)) {
      bounded.truncated = true;
      bounded.omitted_results = omittedResults;
      bounded.omitted_snippets = omittedSnippets;
    }
    return bounded;
  }

  #rrf(items: RankedItem[], limit: number): JsonObject[] {
    const fused = new Map<string, {
      item: JsonObject;
      score: number;
      bestRank: number;
      primaryNode: string;
      primaryNodeOrder: number;
      nodes: Set<string>;
      ranks: Record<string, number>;
      snippets: Map<string, JsonObject>;
      contexts: Map<string, JsonObject>;
    }>();
    const collectObjects = (value: unknown, destination: Map<string, JsonObject>, ranked: RankedItem): void => {
      for (const item of objectItems(value)) {
        const variantHash = createHash("sha256").update(JSON.stringify(item)).digest("hex");
        const identity = typeof item.id === "string" ? item.id : variantHash;
        destination.set(`${ranked.nodeId}:${identity}:${variantHash}`, {
          ...item,
          origin_node: ranked.nodeId,
          ...(ranked.item.origin_scope ? { origin_scope: ranked.item.origin_scope } : {}),
          ...(ranked.item.logical_scope ? { logical_scope: ranked.item.logical_scope } : {})
        });
      }
    };
    for (const ranked of items) {
      const key = dedupeKey(ranked.item, ranked.nodeId, `unique:${ranked.nodeId}:${ranked.rank}`);
      const existing = fused.get(key);
      if (!existing) {
        const snippets = new Map<string, JsonObject>();
        const contexts = new Map<string, JsonObject>();
        collectObjects(ranked.item.record_snippets, snippets, ranked);
        collectObjects(ranked.item.context_records, contexts, ranked);
        fused.set(key, {
          item: ranked.item,
          score: 1 / (this.#rrfK + ranked.rank),
          bestRank: ranked.rank,
          primaryNode: ranked.nodeId,
          primaryNodeOrder: ranked.nodeOrder,
          nodes: new Set([ranked.nodeId]),
          ranks: { [ranked.nodeId]: ranked.rank },
          snippets,
          contexts
        });
        continue;
      }
      const priorRank = existing.ranks[ranked.nodeId];
      if (priorRank === undefined) {
        existing.score += 1 / (this.#rrfK + ranked.rank);
        existing.nodes.add(ranked.nodeId);
        existing.ranks[ranked.nodeId] = ranked.rank;
      } else if (ranked.rank < priorRank) {
        existing.score += 1 / (this.#rrfK + ranked.rank) - 1 / (this.#rrfK + priorRank);
        existing.ranks[ranked.nodeId] = ranked.rank;
      }
      collectObjects(ranked.item.record_snippets, existing.snippets, ranked);
      collectObjects(ranked.item.context_records, existing.contexts, ranked);
      if (ranked.rank < existing.bestRank || (ranked.rank === existing.bestRank && ranked.nodeOrder < existing.primaryNodeOrder)) {
        existing.item = ranked.item;
        existing.bestRank = ranked.rank;
        existing.primaryNode = ranked.nodeId;
        existing.primaryNodeOrder = ranked.nodeOrder;
      }
    }
    return [...fused.values()]
      .sort((left, right) => right.score - left.score || left.bestRank - right.bestRank || left.primaryNodeOrder - right.primaryNodeOrder)
      .slice(0, limit)
      .map((entry) => {
        const snippets = [...entry.snippets.values()];
        const recordContext: JsonObject = {};
        if (entry.item.memory_kind === "record" && snippets.length > 0) {
          recordContext.record_snippet = snippets.find((snippet) => snippet.origin_node === entry.primaryNode) ?? snippets[0];
          recordContext.record_snippets = snippets;
        }
        if (entry.item.memory_kind === "record" && entry.contexts.size > 0) {
          recordContext.context_records = [...entry.contexts.values()];
        }
        return {
          ...entry.item,
          ...recordContext,
          origin_node: entry.primaryNode,
          origin_nodes: [...entry.nodes],
          node_ranks: entry.ranks,
          rrf_score: entry.score
        };
      });
  }

  #selectTargets(requested: string[] | undefined, defaults: string[]): string[] {
    const selected = [...new Set(requested && requested.length > 0 ? requested : defaults)];
    if (selected.length === 0) throw new Error("at least one target node is required");
    for (const target of selected) {
      if (!this.#nodes.has(target)) throw new Error(`unknown target node '${target}'`);
    }
    return selected;
  }

  #limit(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value ?? 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) throw new Error("limit must be an integer from 1 to 50");
    return parsed;
  }

  #retryLimit(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) throw new Error("retry limit must be an integer from 1 to 1000");
    return parsed;
  }
}
