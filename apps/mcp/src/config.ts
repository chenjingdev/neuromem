import { homedir } from "node:os";
import { join } from "node:path";

import type { AuthContext, CoreNodeConfig, RouterConfig } from "./types.js";
import type { McpAuthMode } from "./tools.js";

type Environment = Record<string, string | undefined>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RawNodeConfig {
  id?: unknown;
  base_url?: unknown;
  baseUrl?: unknown;
  token?: unknown;
  scope_map?: unknown;
  scopeMap?: unknown;
}

interface RawRouterConfig {
  nodes?: unknown;
  default_read_targets?: unknown;
  default_write_targets?: unknown;
  state_dir?: unknown;
  request_timeout_ms?: unknown;
  core_max_response_bytes?: unknown;
  rrf_k?: unknown;
  retry_interval_ms?: unknown;
}

export interface McpAuthConfig {
  mode: McpAuthMode;
  context?: AuthContext;
}

export function loadMcpAuthConfig(env: Environment = process.env): McpAuthConfig {
  const mode = (env.NEUROMEM_MCP_AUTH_MODE || (env.NEUROMEM_MCP_AUTH_CONTEXT || env.NEUROMEM_CONTROL_API_URL ? "control" : "hybrid")).toLowerCase();
  if (mode !== "legacy" && mode !== "control" && mode !== "hybrid") {
    throw new Error("NEUROMEM_MCP_AUTH_MODE must be legacy, control, or hybrid");
  }
  if (!env.NEUROMEM_MCP_AUTH_CONTEXT) {
    if (mode === "control" && !env.NEUROMEM_CONTROL_API_URL) throw new Error("control auth requires NEUROMEM_MCP_AUTH_CONTEXT or NEUROMEM_CONTROL_API_URL");
    return { mode };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(env.NEUROMEM_MCP_AUTH_CONTEXT);
  } catch {
    throw new Error("NEUROMEM_MCP_AUTH_CONTEXT is not valid JSON");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("NEUROMEM_MCP_AUTH_CONTEXT must be an object");
  const value = decoded as Record<string, unknown>;
  for (const key of ["principal_id", "credential_id", "workspace_id", "project_id", "human_peer_id"] as const) {
    if (typeof value[key] !== "string" || value[key] === "") throw new Error(`NEUROMEM_MCP_AUTH_CONTEXT.${key} is required`);
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.some((item) => typeof item !== "string")) {
    throw new Error("NEUROMEM_MCP_AUTH_CONTEXT.capabilities must be a string array");
  }
  if (value.client !== undefined && !["codex", "claude", "custom"].includes(String(value.client))) {
    throw new Error("NEUROMEM_MCP_AUTH_CONTEXT.client is invalid");
  }
  return { mode, context: value as unknown as AuthContext };
}

function parsePositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseTargetList(value: unknown): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (!entries) throw new Error("target lists must be arrays or comma-separated strings");
  const normalized = [...new Set(entries.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNode(raw: RawNodeConfig): CoreNodeConfig {
  const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
  const baseUrlValue = typeof raw.base_url === "string" ? raw.base_url : raw.baseUrl;
  const baseUrl = typeof baseUrlValue === "string" ? baseUrlValue.trim() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error("each node id must contain only letters, digits, '_' or '-'");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`node '${id}' has an invalid base URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`node '${id}' base URL must be an HTTP(S) URL without credentials`);
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  const token = typeof raw.token === "string" && raw.token.length > 0 ? raw.token : undefined;
  if (!token || Buffer.byteLength(token, "utf8") < 32) {
    throw new Error(`node '${id}' requires a Core token of at least 32 bytes`);
  }
  const rawScopeMap = raw.scope_map ?? raw.scopeMap;
  let scopeMap: CoreNodeConfig["scopeMap"];
  if (rawScopeMap !== undefined) {
    if (!rawScopeMap || typeof rawScopeMap !== "object" || Array.isArray(rawScopeMap)) {
      throw new Error(`node '${id}' scope map must be an object`);
    }
    scopeMap = {};
    for (const [logicalProjectId, value] of Object.entries(rawScopeMap as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`node '${id}' has an invalid scope mapping`);
      const mapped = value as Record<string, unknown>;
      if (typeof mapped.workspace_id !== "string" || typeof mapped.project_id !== "string") {
        throw new Error(`node '${id}' has an invalid scope mapping`);
      }
      if (!UUID_PATTERN.test(logicalProjectId) || !UUID_PATTERN.test(mapped.workspace_id) || !UUID_PATTERN.test(mapped.project_id)) {
        throw new Error(`node '${id}' scope mappings must use UUIDs`);
      }
      scopeMap[logicalProjectId.toLowerCase()] = {
        workspace_id: mapped.workspace_id.toLowerCase(),
        project_id: mapped.project_id.toLowerCase()
      };
    }
  }
  return {
    id,
    baseUrl: parsed.toString().replace(/\/$/, ""),
    token,
    ...(scopeMap ? { scopeMap } : {})
  };
}

export function loadRouterConfig(env: Environment = process.env): RouterConfig {
  let raw: RawRouterConfig = {};
  let rawNodes: RawNodeConfig[] = [];
  const directValues = [env.NEUROMEM_NODE_ID, env.NEUROMEM_CORE_URL, env.NEUROMEM_CORE_TOKEN];
  if (directValues.some((value) => value !== undefined)) {
    if (directValues.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error("direct mode requires NEUROMEM_NODE_ID, NEUROMEM_CORE_URL, and NEUROMEM_CORE_TOKEN");
    }
    rawNodes = [{
      id: env.NEUROMEM_NODE_ALIAS || env.NEUROMEM_NODE_ID,
      base_url: env.NEUROMEM_CORE_URL,
      token: env.NEUROMEM_CORE_TOKEN
    }];
  } else if (env.NEUROMEM_NODES_JSON) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(env.NEUROMEM_NODES_JSON);
    } catch {
      throw new Error("NEUROMEM_NODES_JSON is not valid JSON");
    }
    if (Array.isArray(decoded)) {
      rawNodes = decoded as RawNodeConfig[];
    } else if (decoded && typeof decoded === "object") {
      raw = decoded as RawRouterConfig;
      if (!Array.isArray(raw.nodes)) throw new Error("NEUROMEM_NODES_JSON.nodes must be an array");
      rawNodes = raw.nodes as RawNodeConfig[];
    } else {
      throw new Error("NEUROMEM_NODES_JSON must be a node array or a router object");
    }
  }

  const nodes = rawNodes.map(normalizeNode);
  if (nodes.length === 0) throw new Error("at least one Core node must be configured");
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
    throw new Error("node ids must be unique");
  }

  const preferredDefault = [nodes[0]!.id];
  const defaultReadTargets = parseTargetList(env.NEUROMEM_DEFAULT_READ_TARGETS ?? raw.default_read_targets) ?? preferredDefault;
  const defaultWriteTargets = parseTargetList(env.NEUROMEM_DEFAULT_WRITE_TARGETS ?? raw.default_write_targets) ?? preferredDefault;
  const known = new Set(nodes.map((node) => node.id));
  for (const target of [...defaultReadTargets, ...defaultWriteTargets]) {
    if (!known.has(target)) throw new Error(`default target '${target}' is not configured`);
  }

  return {
    nodes,
    stateDir: env.NEUROMEM_MCP_STATE_DIR
      ?? (typeof raw.state_dir === "string" ? raw.state_dir : join(homedir(), ".neuromem", "mcp")),
    defaultReadTargets,
    defaultWriteTargets,
    requestTimeoutMs: parsePositiveInteger(env.NEUROMEM_REQUEST_TIMEOUT_MS ?? raw.request_timeout_ms, 120_000, "request timeout"),
    maxCoreResponseBytes: parsePositiveInteger(
      env.NEUROMEM_CORE_MAX_RESPONSE_BYTES ?? raw.core_max_response_bytes,
      64 * 1_048_576,
      "Core response limit"
    ),
    rrfK: parsePositiveInteger(env.NEUROMEM_RRF_K ?? raw.rrf_k, 60, "RRF k"),
    retryIntervalMs: parsePositiveInteger(env.NEUROMEM_RETRY_INTERVAL_MS ?? raw.retry_interval_ms, 30_000, "retry interval")
  };
}
