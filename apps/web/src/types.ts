export type ServiceState = "healthy" | "degraded" | "stopped" | "unavailable" | "starting" | "unknown";

export interface Scope {
  workspaceId: string;
  projectId: string;
  workspaceName?: string;
  projectName?: string;
}

export interface WorkspaceOption {
  id: string;
  name: string;
  projects?: ProjectOption[];
}

export interface ProjectOption {
  id: string;
  name: string;
}

export type WorkspaceRole = "owner" | "admin" | "contributor" | "viewer";
export type MemberStatus = "active" | "invited" | "inactive";
export type PeerStatus = "active" | "inactive";

export interface AgentPeerBinding {
  id: string;
  name?: string;
  client: "codex" | "claude" | "custom" | string;
  owner_principal_id?: string;
  owner_workspace_id?: string;
  status: PeerStatus;
}

export interface WorkspaceMember {
  id: string;
  principal_id: string;
  display_name: string;
  email?: string;
  role: WorkspaceRole;
  status: MemberStatus;
  human_peer_id: string;
  human_peer_status?: PeerStatus;
  agent_peers: AgentPeerBinding[];
}

export interface ApiCredential {
  id: string;
  name: string;
  prefix: string;
  workspace_id: string;
  project_id?: string;
  principal_id: string;
  human_peer_id: string;
  agent_peer_id?: string;
  capabilities: string[];
  expires_at?: string;
  last_used_at?: string;
  revoked_at?: string;
}

export interface CreatedCredential {
  credential: ApiCredential;
  secret: string;
}

export interface ProjectGrant {
  id: string;
  project_id: string;
  principal_id?: string;
  role?: WorkspaceRole;
  capabilities: string[];
  created_at?: string;
}

export type WorkspaceLinkStatus = "proposed" | "active" | "rejected" | "revoked";

export interface WorkspaceLink {
  id: string;
  source_workspace_id: string;
  target_workspace_id: string;
  target_workspace_name?: string;
  status: WorkspaceLinkStatus;
  proposed_by?: string;
  created_at?: string;
}

export interface FederatedProjectGrant {
  id: string;
  workspace_link_id: string;
  source_workspace_id: string;
  source_project_id: string;
  source_project_name?: string;
  target_workspace_id: string;
  capabilities: Array<"search" | "read_source" | string>;
  status: "proposed" | "active" | "revoked" | string;
}

export interface TransferRequest {
  id: string;
  source_workspace_id: string;
  source_project_id: string;
  target_workspace_id: string;
  target_project_id: string;
  record_ids: string[];
  reason: string;
  status: "pending_source" | "pending_target" | "approved" | "rejected" | "completed" | string;
  requested_by?: string;
  created_at?: string;
}

export interface PeerBinding {
  principal_id: string;
  display_name?: string;
  human_peer_id: string;
  human_peer_status: PeerStatus;
  agent_peers: AgentPeerBinding[];
}

export interface TeamDashboard {
  members: WorkspaceMember[];
  peer_bindings: PeerBinding[];
  credentials: ApiCredential[];
  project_grants: ProjectGrant[];
  workspace_links: WorkspaceLink[];
  federated_grants: FederatedProjectGrant[];
  transfer_requests: TransferRequest[];
}

export interface ProcessingSummary {
  pending: number;
  running: number;
  failed: number;
  oldest_pending_seconds?: number | null;
}

export interface Overview {
  workspace: { id: string; name: string };
  project: { id: string; name: string };
  state: ServiceState;
  message?: string;
  counts: {
    records: number;
    claims: number;
    sessions?: number;
    active_vectors?: number;
  };
  processing: ProcessingSummary;
  mcp: {
    url: string;
    state: ServiceState;
  };
  recent_claims?: Claim[];
}

export interface Citation {
  record_id: string;
  label?: string;
  excerpt?: string;
  source?: string;
}

export interface Claim {
  id: string;
  text: string;
  status: "proposed" | "adopted" | "disputed" | "rejected" | "superseded" | string;
  derivation_method?: string;
  project_id?: string;
  updated_at?: string;
  citations?: Citation[];
}

export interface RecallResult {
  id: string;
  kind: "record" | "claim" | string;
  title?: string;
  content: string;
  score?: number;
  project_id?: string;
  citations?: Citation[];
}

export interface WikiSection {
  id: string;
  heading: string;
  body: string;
  claim_ids?: string[];
}

export interface WikiDocument {
  title: string;
  updated_at?: string;
  sections: WikiSection[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  claim_id?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  claim_id?: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RecordContext {
  id: string;
  kind?: string;
  title?: string;
  content: string;
  source?: string;
  author?: string;
  occurred_at?: string;
  project_id?: string;
  before?: string;
  after?: string;
}

export interface ClaimEvidence {
  claim: Claim;
  citations: Citation[];
}

export interface NodeSummary {
  id: string;
  name: string;
  state: ServiceState;
  version?: string;
  endpoint?: string;
}

export interface HealthCheck {
  name: string;
  state: ServiceState;
  detail?: string;
}

export type ModelProviderState = "unconfigured" | "configured" | "unknown" | "ready" | "error";

export interface ModelProviderStatus {
  configured: boolean;
  model?: string;
  provider_status: ModelProviderState;
  provider_detail: string | null;
  last_probe_at: string | null;
}

export interface ModelSelectionProvider {
  model: string | null;
  available_models: string[];
  diagnostic: string | null;
}

export type GenerationSource = "codex_session" | "openai_compatible";
export type CodexAuthStatus = "signed_in" | "signed_out" | "unavailable" | "unknown";
export type ApiKeyAction = "keep" | "replace" | "clear";

export interface CodexGenerationSource {
  available: boolean;
  auth_status: CodexAuthStatus;
  plan_type: string | null;
  available_models: string[];
  diagnostic: string | null;
  last_checked_at: string | null;
}

export interface ApiGenerationSource {
  configured: boolean;
  connection_origin: string | null;
  display_base_url: string | null;
  api_key_configured: boolean;
  model: string | null;
  available_models: string[];
  diagnostic: string | null;
  last_checked_at: string | null;
}

export interface GenerationModelSelection extends ModelSelectionProvider {
  active_source: GenerationSource | null;
  sources: {
    codex_session: CodexGenerationSource;
    openai_compatible: ApiGenerationSource;
  };
}

export interface NodeModelSelection {
  node_id: string;
  embedding: ModelSelectionProvider;
  generation: GenerationModelSelection;
}

export interface ApiGenerationConnectionInput {
  base_url: string;
  api_key_action: ApiKeyAction;
  api_key?: string;
}

export type GenerationProbeInput =
  | { source: "codex_session"; model?: string }
  | { source: "openai_compatible"; model?: string; connection: ApiGenerationConnectionInput };

export interface GenerationProbeResult {
  source: GenerationSource;
  available_models: string[];
  model_compatible: boolean;
  diagnostic: string | null;
  auth_status?: CodexAuthStatus;
  plan_type?: string | null;
  display_base_url?: string | null;
  api_key_configured?: boolean;
  codex?: Partial<CodexGenerationSource>;
}

export type GenerationSelectionUpdate =
  | { source: "codex_session"; model: string }
  | { source: "openai_compatible"; model: string; connection: ApiGenerationConnectionInput };

export interface ModelSelectionUpdate {
  embedding_model?: string;
  generation?: GenerationSelectionUpdate;
}

export interface NodeHealth {
  node?: NodeSummary;
  docker_available?: boolean;
  phase?: string;
  state?: ServiceState;
  message?: string;
  checks?: HealthCheck[];
  components?: Array<{ name: string; state: ServiceState | string; health?: string; detail?: string }>;
  endpoints?: Record<string, string>;
  models?: {
    embedding: ModelProviderStatus;
    extraction: ModelProviderStatus;
  };
  error?: string;
  storage?: {
    database_bytes?: number;
    free_bytes?: number;
    schema_revision?: string;
  };
  updated_at?: string;
}

export interface NodeBacklog extends ProcessingSummary {
  node_id?: string;
  available?: boolean;
  retrying?: number;
  oldest_pending_at?: string;
  error?: string;
}

export interface NodeLog {
  timestamp?: string;
  level?: string;
  service?: string;
  message: string;
}

export interface Backup {
  id: string;
  label: string;
  created_at: string;
  size_bytes?: number;
  state?: "ready" | "creating" | "verified" | "invalid" | string;
  verified_at?: string;
}

export interface OperationResult {
  ok: boolean;
  operation_id?: string;
  node_id?: string;
  kind?: string;
  state?: string;
  phase?: string;
  message?: string;
  result?: unknown;
  backup?: Backup;
}

export interface PlanStep {
  title: string;
  detail?: string;
  state?: "ready" | "warning" | "blocked" | string;
}

export interface OperationPlan {
  id?: string;
  allowed: boolean;
  title: string;
  summary?: string;
  warnings?: string[];
  steps: PlanStep[];
  estimated_downtime_seconds?: number;
}
