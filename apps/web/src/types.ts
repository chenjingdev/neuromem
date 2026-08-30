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

export interface NodeHealth {
  node?: NodeSummary;
  docker_available?: boolean;
  phase?: string;
  state?: ServiceState;
  message?: string;
  checks?: HealthCheck[];
  components?: Array<{ name: string; state: ServiceState | string; health?: string; detail?: string }>;
  endpoints?: Record<string, string>;
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
