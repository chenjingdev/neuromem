import { FederatedMemoryRouter } from "./router.js";
import type { JsonObject, ToolDefinition } from "./types.js";

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
  constructor(readonly router: FederatedMemoryRouter) {}

  listTools(): ToolDefinition[] {
    return MEMORY_TOOLS.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
  }

  async callTool(name: string, argumentsValue?: unknown): Promise<unknown> {
    const input = objectInput(argumentsValue);
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
      case "search_records":
        return this.router.recall(recallInput(input, this.router), ["records"]);
      case "search_claims":
        return this.router.recall(recallInput(input, this.router), ["claims"]);
      case "recall":
        return this.router.recall(recallInput(input, this.router), ["records", "claims"]);
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
      default:
        throw new Error(`unknown memory tool '${name}'`);
    }
  }
}
