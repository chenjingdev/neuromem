export type JsonObject = Record<string, unknown>;

export interface MemoryScope {
  workspace_id: string;
  project_id: string;
}

/**
 * Server-verified identity and scope attached to one MCP credential.
 *
 * Tool arguments must never be used to replace any of these values.  HTTP
 * sessions pin this context at initialize time so a bearer token cannot be
 * swapped mid-session to cross a workspace, project, or peer boundary.
 */
export interface AuthContext {
  principal_id: string;
  credential_id: string;
  workspace_id: string;
  project_id: string;
  human_peer_id: string;
  agent_peer_id?: string;
  capabilities: string[];
  request_id?: string;
  client?: "codex" | "claude" | "custom";
}

export type CredentialResolver = (bearerToken: string) => AuthContext | undefined | Promise<AuthContext | undefined>;

export interface CoreNodeConfig {
  id: string;
  baseUrl: string;
  token?: string;
  scopeMap?: Record<string, MemoryScope>;
}

export interface RouterConfig {
  nodes: CoreNodeConfig[];
  stateDir: string;
  defaultReadTargets?: string[];
  defaultWriteTargets?: string[];
  requestTimeoutMs?: number;
  maxCoreResponseBytes?: number;
  rrfK?: number;
  retryIntervalMs?: number;
}

export type DeliveryState = "stored" | "pending" | "failed";

export interface DeliveryStatus {
  status: DeliveryState;
  http_status?: number;
  error_code?: string;
}

export interface RetryEntry {
  record_id: string;
  target_node: string;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  last_error_code?: string;
}

export interface FederatedError {
  origin_node: string;
  error_code: string;
  http_status?: number;
  origin_scope?: MemoryScope;
  logical_scope?: MemoryScope;
}

export interface FederatedResult {
  results: JsonObject[];
  errors: FederatedError[];
  targets: string[];
  embedding_used?: boolean;
  embedding_used_by_node?: Record<string, boolean>;
  record_snippets?: JsonObject[];
  truncated?: boolean;
  omitted_results?: number;
  omitted_snippets?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}
