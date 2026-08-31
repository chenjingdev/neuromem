import { FederatedMemoryRouter } from "./router.js";
import type { AuthContext, JsonObject, ToolDefinition } from "./types.js";

export type McpAuthMode = "legacy" | "team" | "hybrid";

export interface MemoryToolDispatcherOptions {
  authMode?: McpAuthMode;
  authContext?: AuthContext;
}

const uuidProperty = { type: "string", format: "uuid" };
const uuid7Property = {
  type: "string",
  format: "uuid",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
};
const targetProperty = {
  type: "string",
  enum: ["personal", "company", "both"],
  description: "Node alias to use; omitted means the configured default"
};
const scopeProperties = {
  workspace_id: uuidProperty,
  project_id: uuidProperty
};
const recallProperties = {
  ...scopeProperties,
  query: { type: "string", minLength: 1, maxLength: 10_000 },
  session_id: uuid7Property,
  after: { type: "string", format: "date-time" },
  before: { type: "string", format: "date-time" },
  limit: { type: "integer", minimum: 1, maximum: 50 },
  target: targetProperty
};

export const MEMORY_TOOLS: readonly ToolDefinition[] = [
  {
    name: "memory_record",
    description: "Append one source record to one or more memory nodes",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...scopeProperties,
        session_id: uuid7Property,
        record_id: uuid7Property,
        idempotency_key: { type: "string", minLength: 1, maxLength: 512 },
        author_key: { type: "string", minLength: 1, maxLength: 256 },
        author_name: { type: "string", minLength: 1, maxLength: 256 },
        author_kind: { type: "string", enum: ["human", "agent", "automation", "service"] },
        kind: { type: "string", enum: ["message", "file", "commit", "tool_result", "correction", "note"] },
        content: { type: "string", minLength: 1, maxLength: 1_000_000 },
        occurred_at: { type: "string", format: "date-time" },
        source_app: { type: "string", maxLength: 64 },
        metadata: { type: "object" },
        target: targetProperty
      },
      required: ["workspace_id", "project_id", "session_id", "author_key", "author_kind", "content"]
    }
  },
  {
    name: "search_records",
    description: "Search source records across selected nodes",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: recallProperties,
      required: ["workspace_id", "project_id", "query"]
    }
  },
  {
    name: "search_claims",
    description: "Search derived claims across selected nodes",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: recallProperties,
      required: ["workspace_id", "project_id", "query"]
    }
  },
  {
    name: "recall",
    description: "Search both records and claims across selected nodes",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: recallProperties,
      required: ["workspace_id", "project_id", "query"]
    }
  },
  {
    name: "get_record_context",
    description: "Read neighboring records around one source record",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...scopeProperties, record_id: uuidProperty, target: targetProperty },
      required: ["workspace_id", "project_id", "record_id"]
    }
  },
  {
    name: "get_claim_evidence",
    description: "Read the source evidence attached to one claim",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...scopeProperties, claim_id: uuidProperty, target: targetProperty },
      required: ["workspace_id", "project_id", "claim_id"]
    }
  },
  {
    name: "wiki_read",
    description: "Read the generated project wiki from selected nodes",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...scopeProperties, target: targetProperty },
      required: ["workspace_id", "project_id"]
    }
  },
  {
    name: "graph_read",
    description: "Read the project relationship graph from selected nodes",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...scopeProperties, target: targetProperty },
      required: ["workspace_id", "project_id"]
    }
  }
] as const;

const teamRecallProperties = {
  query: { type: "string", minLength: 1, maxLength: 10_000 },
  session_id: uuid7Property,
  after: { type: "string", format: "date-time" },
  before: { type: "string", format: "date-time" },
  limit: { type: "integer", minimum: 1, maximum: 50 },
  include_general: { type: "boolean", default: true },
  include_federated: { type: "boolean", default: false }
};

/**
 * Credential-bound contract used by the team Gateway.  Workspace, Project,
 * Principal, and author Peer are deliberately absent from every schema.
 */
export const TEAM_MEMORY_TOOLS: readonly ToolDefinition[] = [
  {
    name: "memory_record",
    description: "Record a message as the Human or Agent Peer bound to this credential",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        session_id: uuid7Property, record_id: uuid7Property,
        idempotency_key: { type: "string", minLength: 1, maxLength: 512 },
        speaker: { type: "string", enum: ["human", "agent"] },
        kind: { type: "string", enum: ["message", "file", "commit", "tool_result", "correction", "note"] },
        content: { type: "string", minLength: 1, maxLength: 1_000_000 },
        occurred_at: { type: "string", format: "date-time" }, metadata: { type: "object" }
      },
      required: ["session_id", "speaker", "content"]
    }
  },
  ...["search_records", "search_claims", "recall"].map((name): ToolDefinition => ({
    name,
    description: `${name} within the credential-bound General + current Project context`,
    inputSchema: { type: "object", additionalProperties: false, properties: teamRecallProperties, required: ["query"] }
  })),
  {
    name: "get_record_context", description: "Read neighboring records within the credential scope",
    inputSchema: { type: "object", additionalProperties: false, properties: { record_id: uuidProperty }, required: ["record_id"] }
  },
  {
    name: "get_claim_evidence", description: "Read conclusion evidence within the credential scope",
    inputSchema: { type: "object", additionalProperties: false, properties: { claim_id: uuidProperty }, required: ["claim_id"] }
  },
  {
    name: "wiki_read", description: "Read the current Project Wiki with citations",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "graph_read", description: "Read the current Project relationship graph",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "representation_read", description: "Read a General profile plus current Project overlay",
    inputSchema: { type: "object", additionalProperties: false, properties: { peer_id: uuidProperty, include_general: { type: "boolean", default: true } } }
  },
  {
    name: "peer_card_read", description: "Read the current Peer Card",
    inputSchema: { type: "object", additionalProperties: false, properties: { peer_id: uuidProperty, include_general: { type: "boolean", default: true } } }
  },
  {
    name: "session_context", description: "Read reconstructed Session context",
    inputSchema: { type: "object", additionalProperties: false, properties: { session_id: uuid7Property, include_general: { type: "boolean", default: true } }, required: ["session_id"] }
  },
  {
    name: "dynamic_context", description: "Compile token-bounded Wiki, representation, and source context",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: teamRecallProperties.query, token_budget: { type: "integer", minimum: 256, maximum: 100_000 },
        include_general: { type: "boolean", default: true }, include_federated: { type: "boolean", default: false }
      },
      required: ["query"]
    }
  },
  {
    name: "dialectic_chat", description: "Ask a grounded question without automatically recording the answer",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: teamRecallProperties.query, reasoning_level: { type: "string", enum: ["low", "medium", "high"] },
        include_general: { type: "boolean", default: true }, include_federated: { type: "boolean", default: false }
      }, required: ["query"]
    }
  },
  {
    name: "schedule_dream", description: "Schedule memory consolidation for the current Project",
    inputSchema: { type: "object", additionalProperties: false, properties: { strategy: { type: "string", enum: ["default", "deduction", "induction", "surprisal"] }, force: { type: "boolean", default: false } } }
  },
  {
    name: "federated_search", description: "Search explicitly granted external Projects with source Workspace, Project, Peer, and grant metadata",
    inputSchema: { type: "object", additionalProperties: false, properties: { query: teamRecallProperties.query, limit: teamRecallProperties.limit, include_general: { type: "boolean", default: true } }, required: ["query"] }
  },
  {
    name: "transfer_request", description: "Request an audited transfer of selected records to another Workspace and Project",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        target_workspace_id: uuidProperty, target_project_id: uuidProperty,
        record_id: uuidProperty,
        source_content_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        source_snapshot: { type: "string", minLength: 1, maxLength: 1_000_000 },
        reason: { type: "string", minLength: 1, maxLength: 2_000 }
      }, required: ["target_workspace_id", "target_project_id", "record_id", "source_content_hash", "source_snapshot", "reason"]
    }
  }
] as const;

const ALLOWED_KEYS: Record<string, ReadonlySet<string>> = {
  memory_record: new Set([
    "workspace_id", "project_id", "session_id", "record_id", "idempotency_key", "author_key", "author_name", "author_kind", "kind",
    "content", "occurred_at", "source_app", "metadata", "target"
  ]),
  search_records: new Set(["workspace_id", "project_id", "query", "session_id", "after", "before", "limit", "target"]),
  search_claims: new Set(["workspace_id", "project_id", "query", "session_id", "after", "before", "limit", "target"]),
  recall: new Set(["workspace_id", "project_id", "query", "session_id", "after", "before", "limit", "target"]),
  get_record_context: new Set(["workspace_id", "project_id", "record_id", "target"]),
  get_claim_evidence: new Set(["workspace_id", "project_id", "claim_id", "target"]),
  wiki_read: new Set(["workspace_id", "project_id", "target"]),
  graph_read: new Set(["workspace_id", "project_id", "target"])
};

const TEAM_ALLOWED_KEYS = Object.fromEntries(TEAM_MEMORY_TOOLS.map((tool) => [
  tool.name,
  new Set(Object.keys(tool.inputSchema.properties as JsonObject))
])) as Record<string, ReadonlySet<string>>;

const TEAM_ONLY_NAMES = new Set([
  "representation_read", "peer_card_read", "session_context", "dynamic_context",
  "dialectic_chat", "schedule_dream", "federated_search", "transfer_request"
]);

const TOOL_CAPABILITY: Record<string, string> = {
  memory_record: "project.write",
  search_records: "project.read",
  search_claims: "project.read",
  recall: "project.read",
  get_record_context: "project.read",
  get_claim_evidence: "project.read",
  wiki_read: "wiki:read",
  graph_read: "project.read",
  representation_read: "project.read",
  peer_card_read: "project.read",
  session_context: "project.read",
  dynamic_context: "project.read",
  dialectic_chat: "project.read",
  schedule_dream: "project.write",
  federated_search: "project.read",
  transfer_request: "transfer:request"
};

function objectInput(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("tool arguments must be an object");
  return value as JsonObject;
}

function rejectUnknown(name: string, input: JsonObject): void {
  const allowed = ALLOWED_KEYS[name];
  if (!allowed) throw new Error(`unknown memory tool '${name}'`);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`unknown argument '${unknown[0]}'`);
}

function rejectUnknownTeam(name: string, input: JsonObject): void {
  const allowed = TEAM_ALLOWED_KEYS[name];
  if (!allowed) throw new Error(`unknown memory tool '${name}'`);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`unknown argument '${unknown[0]}'`);
}

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalString(input: JsonObject, key: string, maximum: number): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${key} must be a string from 1 to ${maximum} characters`);
  }
  return value;
}

function optionalDateTime(input: JsonObject, key: string): string | undefined {
  const value = optionalString(input, key, 64);
  if (value !== undefined && (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))
  )) throw new Error(`${key} must be an RFC3339 date-time`);
  return value;
}

function optionalLimit(input: JsonObject): number | undefined {
  if (input.limit === undefined) return undefined;
  if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 50) {
    throw new Error("limit must be an integer from 1 to 50");
  }
  return input.limit as number;
}

function optionalBoolean(input: JsonObject, key: string, fallback: boolean): boolean {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function validateMemoryRecord(input: JsonObject): void {
  const content = requiredString(input, "content");
  if (content.length > 1_000_000 || content.includes("\0")) throw new Error("content is invalid or too long");
  if (requiredString(input, "author_key").length > 256) throw new Error("author_key is too long");
  optionalString(input, "author_name", 256);
  optionalString(input, "source_app", 64);
  optionalDateTime(input, "occurred_at");
  optionalString(input, "idempotency_key", 512);
  if (input.metadata !== undefined && (input.metadata === null || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
    throw new Error("metadata must be an object");
  }
  if (typeof input.author_kind !== "string" || !["human", "agent", "automation", "service"].includes(input.author_kind)) {
    throw new Error("author_kind is invalid");
  }
  if (input.kind !== undefined && !["message", "file", "commit", "tool_result", "correction", "note"].includes(String(input.kind))) {
    throw new Error("kind is invalid");
  }
}

function requiredUuid7(input: JsonObject, key: string): string {
  const value = requiredUuid(input, key);
  if (value[14] !== "7") throw new Error(`${key} must be a UUIDv7`);
  return value.toLowerCase();
}

function optionalUuid7(input: JsonObject, key: string): string | undefined {
  if (input[key] === undefined) return undefined;
  return requiredUuid7(input, key);
}

function requiredUuid(input: JsonObject, key: string): string {
  const value = requiredString(input, key);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${key} must be a UUID`);
  }
  return value.toLowerCase();
}

function optionalUuid(input: JsonObject, key: string): string | undefined {
  return input[key] === undefined ? undefined : requiredUuid(input, key);
}

function targetValue(input: JsonObject): "personal" | "company" | "both" | undefined {
  const target = input.target;
  if (target === undefined) return undefined;
  if (target !== "personal" && target !== "company" && target !== "both") {
    throw new Error("target must be 'personal', 'company', or 'both'");
  }
  return target;
}

function scope(input: JsonObject): { workspaceId: string; projectId: string } {
  return { workspaceId: requiredUuid(input, "workspace_id"), projectId: requiredUuid(input, "project_id") };
}

function recallInput(input: JsonObject, router: FederatedMemoryRouter): JsonObject & {
  workspace_id: string;
  project_id: string;
  query: string;
  targets?: string[];
  limit?: number;
} {
  const query = requiredString(input, "query");
  if (query.length > 10_000) throw new Error("query is too long");
  if (input.session_id !== undefined) requiredUuid7(input, "session_id");
  optionalDateTime(input, "after");
  optionalDateTime(input, "before");
  return {
    ...input,
    workspace_id: requiredUuid(input, "workspace_id"),
    project_id: requiredUuid(input, "project_id"),
    query,
    targets: router.targetsFor(targetValue(input)),
    limit: optionalLimit(input)
  };
}

export class MemoryToolDispatcher {
  readonly authMode: McpAuthMode;
  readonly authContext?: AuthContext;

  constructor(readonly router: FederatedMemoryRouter, options: MemoryToolDispatcherOptions = {}) {
    this.authMode = options.authMode ?? "hybrid";
    this.authContext = options.authContext;
    if (!(["legacy", "team", "hybrid"] as string[]).includes(this.authMode)) throw new Error("authMode must be legacy, team, or hybrid");
    if (this.authMode === "team" && !this.authContext) throw new Error("team auth mode requires an AuthContext");
    if (this.authContext) {
      for (const key of ["principal_id", "credential_id", "workspace_id", "project_id", "human_peer_id"] as const) {
        if (!this.authContext[key]) throw new Error(`AuthContext.${key} is required`);
      }
      if (!Array.isArray(this.authContext.capabilities)) throw new Error("AuthContext.capabilities is required");
    }
  }

  withAuthContext(authContext: AuthContext, authMode: McpAuthMode = "team"): MemoryToolDispatcher {
    return new MemoryToolDispatcher(this.router, { authContext, authMode });
  }

  listTools(): ToolDefinition[] {
    let tools: readonly ToolDefinition[];
    if (this.authMode === "legacy" || !this.authContext) {
      tools = MEMORY_TOOLS;
    } else if (this.authMode === "team") {
      tools = TEAM_MEMORY_TOOLS.filter((tool) => this.#hasCapability(TOOL_CAPABILITY[tool.name]!));
    } else {
      tools = [
        ...MEMORY_TOOLS.filter((tool) => this.#hasCapability(TOOL_CAPABILITY[tool.name]!)),
        ...TEAM_MEMORY_TOOLS.filter((tool) => TEAM_ONLY_NAMES.has(tool.name) && this.#hasCapability(TOOL_CAPABILITY[tool.name]!))
      ];
    }
    return tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
  }

  async callTool(name: string, argumentsValue?: unknown): Promise<unknown> {
    const input = objectInput(argumentsValue);
    if (this.authMode === "team") return this.#callTeam(name, input);
    if (this.authMode === "hybrid" && this.authContext) {
      this.#requireCapability(name);
      if (TEAM_ONLY_NAMES.has(name)) return this.#callTeam(name, input);
      this.#assertLegacyScopeAndPeer(input, name);
    }
    return this.#callLegacy(name, input);
  }

  async #callLegacy(name: string, input: JsonObject): Promise<unknown> {
    rejectUnknown(name, input);
    const targets = this.router.targetsFor(targetValue(input));
    switch (name) {
      case "memory_record":
        validateMemoryRecord(input);
        return this.router.memoryRecord({
          ...input,
          workspace_id: requiredUuid(input, "workspace_id"),
          project_id: requiredUuid(input, "project_id"),
          session_id: requiredUuid7(input, "session_id"),
          record_id: optionalUuid7(input, "record_id"),
          author_key: requiredString(input, "author_key"),
          author_kind: input.author_kind as "human" | "agent" | "automation" | "service",
          content: requiredString(input, "content"),
          targets
        });
      case "search_records": return this.router.recall(recallInput(input, this.router), ["records"]);
      case "search_claims": return this.router.recall(recallInput(input, this.router), ["claims"]);
      case "recall": return this.router.recall(recallInput(input, this.router), ["records", "claims"]);
      case "get_record_context": {
        const { workspaceId, projectId } = scope(input);
        return this.router.getRecordContext(workspaceId, projectId, requiredUuid(input, "record_id"), targets);
      }
      case "get_claim_evidence": {
        const { workspaceId, projectId } = scope(input);
        return this.router.getClaimEvidence(workspaceId, projectId, requiredUuid(input, "claim_id"), targets);
      }
      case "wiki_read": {
        const { workspaceId, projectId } = scope(input);
        return this.router.wikiRead(workspaceId, projectId, targets);
      }
      case "graph_read": {
        const { workspaceId, projectId } = scope(input);
        return this.router.graphRead(workspaceId, projectId, targets);
      }
      default: throw new Error(`unknown memory tool '${name}'`);
    }
  }

  async #callTeam(name: string, input: JsonObject): Promise<unknown> {
    if (!this.authContext) throw new Error("credential-bound AuthContext is required");
    rejectUnknownTeam(name, input);
    this.#requireCapability(name);
    const workspaceId = this.authContext.workspace_id;
    const projectId = this.authContext.project_id;
    switch (name) {
      case "memory_record": {
        const speaker = requiredString(input, "speaker");
        if (speaker !== "human" && speaker !== "agent") throw new Error("speaker must be 'human' or 'agent'");
        const peerId = speaker === "human" ? this.authContext.human_peer_id : this.authContext.agent_peer_id;
        if (!peerId) throw new Error("this credential is not bound to an Agent Peer");
        const recordInput = {
          ...input,
          author_key: peerId,
          author_name: peerId,
          author_kind: speaker,
          source_app: this.authContext.client ?? "neuromem-mcp"
        };
        validateMemoryRecord(recordInput);
        return this.router.memoryRecord({
          ...recordInput,
          workspace_id: workspaceId,
          project_id: projectId,
          session_id: requiredUuid7(input, "session_id"),
          record_id: optionalUuid7(input, "record_id"),
          author_key: peerId,
          author_kind: speaker,
          content: requiredString(input, "content")
        });
      }
      case "search_records": return this.router.recall(this.#teamRecall(input), ["records"]);
      case "search_claims": return this.router.recall(this.#teamRecall(input), ["claims"]);
      case "recall": return this.router.recall(this.#teamRecall(input), ["records", "claims"]);
      case "get_record_context": return this.router.getRecordContext(workspaceId, projectId, requiredUuid(input, "record_id"));
      case "get_claim_evidence": return this.router.getClaimEvidence(workspaceId, projectId, requiredUuid(input, "claim_id"));
      case "wiki_read": return this.router.wikiRead(workspaceId, projectId);
      case "graph_read": return this.router.graphRead(workspaceId, projectId);
      case "representation_read": return this.router.representationRead(workspaceId, projectId, this.#readablePeer(input), optionalBoolean(input, "include_general", true));
      case "peer_card_read": return this.router.peerCardRead(workspaceId, projectId, this.#readablePeer(input), optionalBoolean(input, "include_general", true));
      case "session_context": return this.router.sessionContextRead(workspaceId, projectId, requiredUuid7(input, "session_id"), optionalBoolean(input, "include_general", true));
      case "dynamic_context": {
        const tokenBudget = input.token_budget;
        if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || Number(tokenBudget) < 256 || Number(tokenBudget) > 100_000)) throw new Error("token_budget must be an integer from 256 to 100000");
        return this.router.dynamicContext({
          workspace_id: workspaceId, project_id: projectId, query: this.#query(input), token_budget: tokenBudget,
          include_general: optionalBoolean(input, "include_general", true),
          include_federated: optionalBoolean(input, "include_federated", false)
        });
      }
      case "dialectic_chat": {
        const level = input.reasoning_level ?? "low";
        if (!["low", "medium", "high"].includes(String(level))) throw new Error("reasoning_level is invalid");
        return this.router.dialecticChat({
          workspace_id: workspaceId, project_id: projectId, query: this.#query(input), reasoning_level: level,
          include_general: optionalBoolean(input, "include_general", true),
          include_federated: optionalBoolean(input, "include_federated", false)
        });
      }
      case "schedule_dream": {
        const strategy = input.strategy ?? "default";
        if (!["default", "deduction", "induction", "surprisal"].includes(String(strategy))) throw new Error("strategy is invalid");
        return this.router.scheduleDream(workspaceId, projectId, { strategy, force: optionalBoolean(input, "force", false) });
      }
      case "federated_search": return this.router.recall({ ...this.#teamRecall({ ...input, include_federated: true }), include_federated: true }, ["records", "claims"]);
      case "transfer_request": {
        const contentHash = requiredString(input, "source_content_hash");
        if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new Error("source_content_hash must be a lowercase SHA-256 hex digest");
        const snapshot = requiredString(input, "source_snapshot");
        if (snapshot.length > 1_000_000 || snapshot.includes("\0")) throw new Error("source_snapshot is invalid or too long");
        return this.router.createTransferRequest(workspaceId, projectId, {
          target_workspace_id: requiredUuid(input, "target_workspace_id"),
          target_project_id: requiredUuid(input, "target_project_id"),
          source_record_id: requiredUuid(input, "record_id"),
          source_content_hash: contentHash,
          source_snapshot: snapshot,
          provenance: { reason: requiredString(input, "reason") }
        });
      }
      default: throw new Error(`unknown memory tool '${name}'`);
    }
  }

  #teamRecall(input: JsonObject): JsonObject & {
    workspace_id: string; project_id: string; query: string; limit?: number; include_general: boolean; include_federated: boolean;
  } {
    if (input.session_id !== undefined) requiredUuid7(input, "session_id");
    optionalDateTime(input, "after");
    optionalDateTime(input, "before");
    return {
      ...input,
      workspace_id: this.authContext!.workspace_id,
      project_id: this.authContext!.project_id,
      query: this.#query(input),
      limit: optionalLimit(input),
      include_general: optionalBoolean(input, "include_general", true),
      include_federated: optionalBoolean(input, "include_federated", false)
    };
  }

  #query(input: JsonObject): string {
    const query = requiredString(input, "query");
    if (query.length > 10_000) throw new Error("query is too long");
    return query;
  }

  #readablePeer(input: JsonObject): string {
    const requested = optionalUuid(input, "peer_id") ?? this.authContext!.human_peer_id;
    if (requested !== this.authContext!.human_peer_id && requested !== this.authContext!.agent_peer_id && !this.#hasCapability("peer:read:any")) {
      throw new Error("credential cannot read another Peer");
    }
    return requested;
  }

  #hasCapability(capability: string): boolean {
    if (!this.authContext) return true;
    return this.authContext.capabilities.includes("*")
      || this.authContext.capabilities.includes(capability)
      || (capability === "transfer.request" && this.authContext.capabilities.includes("transfer.manage"));
  }

  #requireCapability(name: string): void {
    const capability = TOOL_CAPABILITY[name];
    if (!capability) throw new Error(`unknown memory tool '${name}'`);
    if (!this.#hasCapability(capability)) throw new Error(`credential lacks '${capability}' capability`);
  }

  #assertLegacyScopeAndPeer(input: JsonObject, name: string): void {
    const { workspaceId, projectId } = scope(input);
    if (workspaceId !== this.authContext!.workspace_id || projectId !== this.authContext!.project_id) {
      throw new Error("tool scope does not match the credential-bound Workspace and Project");
    }
    if (name !== "memory_record") return;
    const kind = requiredString(input, "author_kind");
    const expectedPeer = kind === "human" ? this.authContext!.human_peer_id : kind === "agent" ? this.authContext!.agent_peer_id : undefined;
    if (!expectedPeer || requiredString(input, "author_key") !== expectedPeer) {
      throw new Error("author identity does not match the credential-bound Peer");
    }
  }
}
