import type {
  Backup,
  ApiCredential,
  Claim,
  ClaimEvidence,
  KnowledgeGraph,
  NodeBacklog,
  NodeHealth,
  NodeLog,
  NodeModelSelection,
  NodeSummary,
  GenerationProbeInput,
  GenerationProbeResult,
  ModelSelectionUpdate,
  OperationPlan,
  OperationResult,
  Overview,
  RecallResult,
  RecordContext,
  Scope,
  CreatedCredential,
  FederatedProjectGrant,
  PeerBinding,
  ProjectGrant,
  TeamDashboard,
  TransferRequest,
  WorkspaceLink,
  WorkspaceMember,
  WorkspaceRole,
  WikiDocument,
  WorkspaceOption,
} from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const coreBase = trimBase(import.meta.env.VITE_CORE_API_URL || "/core-api");
const teamBase = trimBase(import.meta.env.VITE_TEAM_API_URL || "/api");
let managerBase = trimBase(import.meta.env.VITE_MANAGER_API_URL || "http://127.0.0.1:14174");

function trimBase(value: string) {
  return value.replace(/\/+$/, "");
}

function scoped(path: string, scope: Scope) {
  const params = new URLSearchParams({ workspace_id: scope.workspaceId, project_id: scope.projectId });
  return `${path}${path.includes("?") ? "&" : "?"}${params}`;
}

async function request<T>(base: string, path: string, init: RequestInit & { manager?: boolean } = {}): Promise<T> {
  const { manager, ...requestInit } = init;
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...requestInit,
      credentials: manager ? "include" : requestInit.credentials,
      headers: {
        accept: "application/json",
        ...(requestInit.body ? { "content-type": "application/json" } : {}),
        ...requestInit.headers,
      },
    });
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "서버에 연결할 수 없습니다.");
  }

  const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!response.ok) {
    throw new ApiError(payload?.error || payload?.message || `요청에 실패했습니다 (${response.status}).`, response.status);
  }
  return payload as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const patchJson = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
const deleteRequest = (): RequestInit => ({ method: "DELETE" });
const teamHeaders = (workspaceId: string, projectId?: string): Record<string, string> => ({
  "x-neuromem-workspace": workspaceId,
  ...(projectId ? { "x-neuromem-project": projectId } : {}),
});

function listItems<T>(payload: { items?: T[] } | T[]): T[] {
  return Array.isArray(payload) ? payload : payload.items || [];
}

interface RawRecord {
  id: string;
  kind: string;
  content: string;
  occurred_at: string;
  source_app?: string | null;
  project_id: string;
}

interface RawMembership {
  id: string;
  workspace_id: string;
  principal_id: string;
  role: WorkspaceRole;
  status: "active" | "inactive";
}

interface RawPeerBinding {
  principal_id: string | null;
  peer: { id: string; workspace_id: string; name: string; kind: string; status: string };
  kind: string;
  client?: string | null;
  owner_principal_id?: string | null;
  owner_workspace_id?: string | null;
  status: string;
}

interface RawCredential {
  id: string;
  principal_id: string;
  workspace_id: string;
  agent_peer_id?: string | null;
  name: string;
  kind: string;
  token_prefix: string;
  capabilities: string[];
  project_ids: string[];
  expires_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
}

interface RawTransfer {
  id: string;
  source_workspace_id: string;
  source_project_id: string;
  target_workspace_id: string;
  target_project_id: string;
  requested_by_principal_id?: string;
  source_record_id: string;
  source_content_hash?: string;
  source_snapshot?: string;
  reviewed_content?: string | null;
  provenance?: Record<string, unknown>;
  status: string;
  rejection_reason?: string | null;
  created_at?: string;
}

interface RawClaim {
  id: string;
  content: string;
  status: string;
  derivation_method: string;
  project_id: string;
  occurred_at?: string;
  created_at: string;
}

interface RawNode {
  node_id: string;
  alias: string;
  ports: { api: number; dashboard: number; mcp: number };
  generation: number;
  desired_state: "running" | "stopped";
  phase: "stopped" | "starting" | "ready" | "degraded" | "maintenance" | "failed";
  compose_project: string;
  schema_revision: string;
  created_at: string;
  updated_at: string;
}

interface RawBackup {
  backup_id: string;
  label?: string;
  node_id: string;
  node_alias: string;
  generation: number;
  schema_revision: string;
  created_at: string;
  archive_bytes: number;
  verified: boolean;
}

interface RawOperation extends Omit<OperationResult, "result"> { error?: string; result?: unknown }

interface RawRestorePlan {
  ok: boolean;
  node_id: string;
  backup: RawBackup;
  current_generation: number;
  candidate_generation: number;
  free_bytes: number;
  required_bytes: number;
  steps: string[];
  blockers: string[];
}

interface RawMigrationPlan {
  ok: boolean;
  node_id: string;
  current_revision: string;
  target_revision: string;
  requires_backup: boolean;
  apply_mode: "transactional" | "new_generation";
  blockers: string[];
}

export const coreApi = {
  workspaces: async () => {
    const payload = await request<{ items?: WorkspaceOption[]; workspaces?: WorkspaceOption[] }>(coreBase, "/v1/workspaces");
    const workspaces = payload.items || payload.workspaces || [];
    return Promise.all(workspaces.map(async workspace => {
      const projects = await request<{ items?: WorkspaceOption["projects"]; projects?: WorkspaceOption["projects"] }>(
        coreBase,
        `/v1/workspaces/${encodeURIComponent(workspace.id)}/projects`,
      );
      return { ...workspace, projects: projects.items || projects.projects || [] };
    }));
  },
  createWorkspace: (name: string) => request<WorkspaceOption>(coreBase, "/v1/workspaces", json({ name })),
  createProject: (workspaceId: string, name: string) => request<{ id: string; name: string }>(
    coreBase,
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`,
    json({ name }),
  ),
  overview: async (scope: Scope) => normalizeOverview(await request<RawOverview>(coreBase, scoped(`/v1/projects/${encodeURIComponent(scope.projectId)}/overview`, scope)), scope),
  recall: async (scope: Scope, query: string) => normalizeRecall(await request<RawRecall>(coreBase, "/v1/recall", json({
    workspace_id: scope.workspaceId,
    project_id: scope.projectId,
    query,
  }))),
  claims: async (scope: Scope) => {
    const payload = await request<{ items: Array<{ claim: RawClaim; evidence_count: number }> }>(coreBase, scoped(`/v1/projects/${encodeURIComponent(scope.projectId)}/claims`, scope));
    return { items: payload.items.map(item => normalizeClaim(item.claim)) };
  },
  claimEvidence: async (scope: Scope, claimId: string) => normalizeClaimEvidence(await request<RawClaimEvidence>(coreBase, scoped(`/v1/claims/${encodeURIComponent(claimId)}/evidence`, scope))),
  wiki: async (scope: Scope) => normalizeWiki(await request<RawWiki>(coreBase, scoped(`/v1/projects/${encodeURIComponent(scope.projectId)}/wiki`, scope)), scope),
  graph: async (scope: Scope) => normalizeGraph(await request<RawGraph>(coreBase, scoped(`/v1/projects/${encodeURIComponent(scope.projectId)}/graph`, scope))),
  recordContext: async (scope: Scope, recordId: string) => normalizeRecordContext(await request<{ target_record_id: string; records: RawRecord[] }>(coreBase, scoped(`/v1/records/${encodeURIComponent(recordId)}/context`, scope))),
  retryFailedJobs: (scope: Scope) => request<{ retried: number }>(coreBase, "/v1/jobs:retry-failed", json({
    workspace_id: scope.workspaceId,
    project_id: scope.projectId,
  })),
};

function normalizePeerBindings(rows: RawPeerBinding[], workspaceId: string): PeerBinding[] {
  const grouped = new Map<string, PeerBinding>();
  for (const row of rows) {
    if (row.kind === "primary_human" && row.principal_id) {
      const existing = grouped.get(row.principal_id);
      grouped.set(row.principal_id, {
        principal_id: row.principal_id,
        display_name: row.peer.name,
        human_peer_id: row.peer.id,
        human_peer_status: row.status === "inactive" ? "inactive" : "active",
        agent_peers: existing?.agent_peers || [],
      });
    }
  }
  for (const row of rows) {
    if (row.kind !== "agent_owner") continue;
    const ownerKey = row.owner_principal_id || `workspace:${row.owner_workspace_id || workspaceId}`;
    const existing = grouped.get(ownerKey) || {
      principal_id: ownerKey,
      display_name: row.owner_principal_id ? row.owner_principal_id : "Workspace 공용 Agent",
      human_peer_id: "",
      human_peer_status: "active" as const,
      agent_peers: [],
    };
    existing.agent_peers.push({
      id: row.peer.id,
      name: row.peer.name,
      client: row.client || "custom",
      owner_principal_id: row.owner_principal_id || undefined,
      owner_workspace_id: row.owner_workspace_id || undefined,
      status: row.status === "inactive" ? "inactive" : "active",
    });
    grouped.set(ownerKey, existing);
  }
  return [...grouped.values()];
}

function normalizeCredential(raw: RawCredential): ApiCredential {
  return {
    id: raw.id,
    name: raw.name,
    prefix: raw.token_prefix,
    workspace_id: raw.workspace_id,
    project_id: raw.project_ids[0],
    principal_id: raw.principal_id,
    human_peer_id: "",
    agent_peer_id: raw.agent_peer_id || undefined,
    capabilities: raw.capabilities,
    expires_at: raw.expires_at || undefined,
    last_used_at: raw.last_used_at || undefined,
    revoked_at: raw.revoked_at || undefined,
  };
}

function normalizeTransfer(raw: RawTransfer): TransferRequest {
  return {
    id: raw.id,
    source_workspace_id: raw.source_workspace_id,
    source_project_id: raw.source_project_id,
    target_workspace_id: raw.target_workspace_id,
    target_project_id: raw.target_project_id,
    record_ids: [raw.source_record_id],
    reason: typeof raw.provenance?.reason === "string" ? raw.provenance.reason : raw.rejection_reason || "기억 이관 요청",
    status: raw.status,
    requested_by: raw.requested_by_principal_id,
    created_at: raw.created_at,
  };
}

/** Workspace product APIs. These always use the browser's product session;
 * host/node administration remains isolated in managerApi. */
export const teamApi = {
  members: async (workspaceId: string) => listItems(await request<{ items?: RawMembership[] } | RawMembership[]>(
    teamBase, `/v1/workspaces/${encodeURIComponent(workspaceId)}/members`, { credentials: "include", headers: teamHeaders(workspaceId) },
  )).map((member): WorkspaceMember => ({
    ...member, display_name: member.principal_id, human_peer_id: "", human_peer_status: member.status,
    agent_peers: [],
  })),
  inviteMember: async (workspaceId: string, input: { email: string; role: WorkspaceRole }) => {
    const result = await request<{ invitation: { id: string; expires_at: string }; token: string }>(
      teamBase, `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`, { ...json(input), credentials: "include", headers: teamHeaders(workspaceId) },
    );
    return { invitation_id: result.invitation.id, invite_url: result.token, expires_at: result.invitation.expires_at };
  },
  updateMember: (workspaceId: string, memberId: string, input: { role?: WorkspaceRole; status?: "active" | "inactive" }) => request<RawMembership>(
    teamBase, `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`, { ...patchJson(input), credentials: "include", headers: teamHeaders(workspaceId) },
  ),
  peerBindings: async (workspaceId: string): Promise<PeerBinding[]> => normalizePeerBindings(listItems(await request<{ items?: RawPeerBinding[] } | RawPeerBinding[]>(
    teamBase, `/v1/workspaces/${encodeURIComponent(workspaceId)}/peer-bindings`, { credentials: "include", headers: teamHeaders(workspaceId) },
  )), workspaceId),
  credentials: async (workspaceId: string) => listItems(await request<{ items?: RawCredential[] } | RawCredential[]>(
    teamBase, "/v1/credentials", { credentials: "include", headers: teamHeaders(workspaceId) },
  )).map(normalizeCredential),
  createCredential: (input: {
    workspace_id: string;
    project_id?: string;
    name: string;
    client: "codex" | "claude" | "custom";
    agent_peer_id?: string;
    capabilities: string[];
  }) => request<{ credential: RawCredential; token: string }>(teamBase, "/v1/credentials", {
    ...json({ name: input.name, kind: "mcp", agent_peer_id: input.agent_peer_id, capabilities: input.capabilities, project_ids: input.project_id ? [input.project_id] : [] }),
    credentials: "include", headers: teamHeaders(input.workspace_id, input.project_id),
  }).then((result): CreatedCredential => ({ credential: normalizeCredential(result.credential), secret: result.token })),
  revokeCredential: (scope: Scope, credentialId: string) => request<void>(
    teamBase, `/v1/credentials/${encodeURIComponent(credentialId)}`, { ...deleteRequest(), credentials: "include", headers: teamHeaders(scope.workspaceId, scope.projectId) },
  ),
  projectGrants: async (scope: Scope) => listItems(await request<{ items?: ProjectGrant[] } | ProjectGrant[]>(
    teamBase, `/v1/projects/${encodeURIComponent(scope.projectId)}/grants`, { credentials: "include", headers: teamHeaders(scope.workspaceId, scope.projectId) },
  )),
  createProjectGrant: (scope: Scope, input: { principal_id: string; capabilities: string[] }) => request<ProjectGrant>(
    teamBase, `/v1/projects/${encodeURIComponent(scope.projectId)}/grants`, { ...json(input), credentials: "include", headers: teamHeaders(scope.workspaceId, scope.projectId) },
  ),
  revokeProjectGrant: (scope: Scope, grantId: string) => request<void>(
    teamBase, `/v1/projects/${encodeURIComponent(scope.projectId)}/grants/${encodeURIComponent(grantId)}`, { ...deleteRequest(), credentials: "include", headers: teamHeaders(scope.workspaceId, scope.projectId) },
  ),
  workspaceLinks: async (workspaceId: string) => listItems(await request<{ items?: WorkspaceLink[] } | WorkspaceLink[]>(
    teamBase, "/v1/workspace-links", { credentials: "include", headers: teamHeaders(workspaceId) },
  )),
  createWorkspaceLink: (input: { source_workspace_id: string; target_workspace_id: string }) => request<WorkspaceLink>(
    teamBase, "/v1/workspace-links", { ...json(input), credentials: "include", headers: teamHeaders(input.source_workspace_id) },
  ),
  approveWorkspaceLink: (workspaceId: string, linkId: string) => request<WorkspaceLink>(
    teamBase, `/v1/workspace-links/${encodeURIComponent(linkId)}:approve`, { ...json({}), credentials: "include", headers: teamHeaders(workspaceId) },
  ),
  federatedGrants: async (workspaceId: string) => listItems(await request<{ items?: FederatedProjectGrant[] } | FederatedProjectGrant[]>(
    teamBase, "/v1/federated-project-grants", { credentials: "include", headers: teamHeaders(workspaceId) },
  )),
  createFederatedGrant: (workspaceId: string, input: {
    workspace_link_id: string;
    source_project_id: string;
    capabilities: Array<"search" | "read_source">;
  }) => request<FederatedProjectGrant>(teamBase, "/v1/federated-project-grants", { ...json(input), credentials: "include", headers: teamHeaders(workspaceId) }),
  transferRequests: async (workspaceId: string) => listItems(await request<{ items?: RawTransfer[] } | RawTransfer[]>(
    teamBase, `/v1/transfer-requests?workspace_id=${encodeURIComponent(workspaceId)}`, { credentials: "include", headers: teamHeaders(workspaceId) },
  )).map(normalizeTransfer),
  resolveTransferRequest: (scope: Scope, requestId: string, decision: "approve" | "reject") => request<RawTransfer>(
    teamBase, `/v1/transfer-requests/${encodeURIComponent(requestId)}:${decision}`, {
      ...json(decision === "approve" ? {} : { reason: "Workspace 관리자가 이관을 거절했습니다." }),
      credentials: "include", headers: teamHeaders(scope.workspaceId, scope.projectId),
    },
  ).then(normalizeTransfer),
  dashboard: async (scope: Scope): Promise<TeamDashboard> => {
    const [members, peerBindings, credentials, projectGrants, workspaceLinks, federatedGrants, transferRequests] = await Promise.all([
      teamApi.members(scope.workspaceId),
      teamApi.peerBindings(scope.workspaceId),
      teamApi.credentials(scope.workspaceId),
      teamApi.projectGrants(scope),
      teamApi.workspaceLinks(scope.workspaceId),
      teamApi.federatedGrants(scope.workspaceId),
      teamApi.transferRequests(scope.workspaceId),
    ]);
    return {
      members: members.map(member => {
        const binding = peerBindings.find(item => item.principal_id === member.principal_id);
        return {
          ...member,
          display_name: binding?.display_name || member.display_name,
          human_peer_id: binding?.human_peer_id || member.human_peer_id,
          human_peer_status: binding?.human_peer_status || member.human_peer_status,
          agent_peers: binding?.agent_peers || [],
        };
      }),
      peer_bindings: peerBindings,
      credentials: credentials.map(credential => ({
        ...credential,
        human_peer_id: peerBindings.find(item => item.principal_id === credential.principal_id)?.human_peer_id || "",
      })),
      project_grants: projectGrants,
      workspace_links: workspaceLinks,
      federated_grants: federatedGrants,
      transfer_requests: transferRequests,
    };
  },
};

export const managerApi = {
  nodes: async () => {
    const payload = await managerRequest<{ nodes: RawNode[] }>("/v1/nodes");
    return payload.nodes.map(normalizeNode);
  },
  health: async (nodeId: string) => normalizeNodeHealth(await managerRequest<RawNodeHealth>(`/v1/nodes/${encodeURIComponent(nodeId)}/health`)),
  models: (nodeId: string) => managerRequest<NodeModelSelection>(`/v1/nodes/${encodeURIComponent(nodeId)}/models`),
  probeGeneration: (nodeId: string, input: GenerationProbeInput) => managerRequest<GenerationProbeResult>(`/v1/nodes/${encodeURIComponent(nodeId)}/generation/probe`, json(input)),
  configureModels: (nodeId: string, updates: ModelSelectionUpdate) => managerOperation(`/v1/nodes/${encodeURIComponent(nodeId)}/models`, json(updates)),
  backlog: async (nodeId: string) => normalizeBacklog(await managerRequest<RawBacklog>(`/v1/nodes/${encodeURIComponent(nodeId)}/backlog`)),
  logs: async (nodeId: string, tail = 100): Promise<NodeLog[]> => {
    const payload = await managerRequest<{ items?: NodeLog[]; logs?: NodeLog[] | string }>(`/v1/nodes/${encodeURIComponent(nodeId)}/logs?service=api&tail=${tail}`);
    if (Array.isArray(payload.logs)) return payload.logs;
    if (typeof payload.logs === "string") return payload.logs.split(/\r?\n/).filter(Boolean).map(message => ({ message } as NodeLog));
    return payload.items || [];
  },
  backups: async (nodeId: string) => {
    const payload = await managerRequest<{ backups: RawBackup[] }>(`/v1/nodes/${encodeURIComponent(nodeId)}/backups`);
    return payload.backups.map(normalizeBackup);
  },
  control: (nodeId: string, action: "start" | "stop" | "restart") => managerOperation(`/v1/nodes/${encodeURIComponent(nodeId)}/${action}`, json({})),
  createBackup: (nodeId: string, label: string) => managerOperation(`/v1/nodes/${encodeURIComponent(nodeId)}/backups`, json({ label })),
  verifyBackup: (nodeId: string, backupId: string) => managerOperation(`/v1/nodes/${encodeURIComponent(nodeId)}/backups/${encodeURIComponent(backupId)}/verify`, json({})),
  restorePlan: async (nodeId: string, backupId: string) => {
    const operation = await managerRequest<RawOperation>(`/v1/nodes/${encodeURIComponent(nodeId)}/restore/plan`, json({ backup_id: backupId }));
    return normalizeRestorePlan(requireOperationResult<RawRestorePlan>(operation));
  },
  migratePlan: async (nodeId: string, targetRevision = "latest") => {
    const operation = await managerRequest<RawOperation>(`/v1/nodes/${encodeURIComponent(nodeId)}/migrate/plan`, json({ target_revision: targetRevision, apply_mode: "new_generation" }));
    return normalizeMigrationPlan(requireOperationResult<RawMigrationPlan>(operation));
  },
};

interface RawOverview {
  workspace_id: string;
  project_id: string;
  records: number;
  claims: number;
  sessions: number;
  peers: number;
  jobs: Record<string, number>;
  last_ingested_at?: string;
  embedding_configured: boolean;
  extraction_configured: boolean;
  mcp_url?: string;
}

interface RawRecall {
  records: Array<{ record_id: string; project_id: string; content: string; matched_content: string; rank: number; rrf_score?: number }>;
  claims: Array<{ claim_id: string; project_id: string; content: string; status: string; derivation_method: string; evidence_ids: string[]; rank: number; rrf_score?: number }>;
}

interface RawClaimEvidence {
  claim: RawClaim;
  evidence: Array<{ source_id: string; role: string; quote?: string; record: RawRecord }>;
}

interface RawWiki {
  project_id: string;
  generated_at: string;
  sections: Array<{ title: string; claims: Array<{ claim_id: string; content: string; evidence_count: number; updated_at: string }> }>;
}

interface RawGraph {
  nodes: Array<{ id: string; type: string; label: string }>;
  edges: Array<{ id: string; claim_id: string; source: string; predicate: string; target: string }>;
}

interface RawNodeHealth {
  node: RawNode;
  docker_available: boolean;
  phase: RawNode["phase"];
  components: Array<{ name: string; state: string; health?: string; detail?: string }>;
  endpoints: Record<string, string>;
  models?: {
    embedding: {
      configured: boolean;
      model?: string;
      provider_status: "unconfigured" | "configured" | "unknown" | "ready" | "error";
      provider_detail: string | null;
      last_probe_at: string | null;
    };
    extraction: {
      configured: boolean;
      model?: string;
      provider_status: "unconfigured" | "configured" | "unknown" | "ready" | "error";
      provider_detail: string | null;
      last_probe_at: string | null;
    };
  };
  error?: string;
}

interface RawBacklog {
  node_id?: string;
  available?: boolean;
  counts?: Record<string, number>;
  pending?: number | null;
  running?: number | null;
  retrying?: number;
  failed?: number | null;
  oldest_pending_at?: string | null;
  oldest_pending_seconds?: number | null;
  error?: string;
}

export function normalizeOverview(raw: RawOverview, scope: Scope): Overview {
  const pending = raw.jobs.pending || raw.jobs.queued || 0;
  const running = raw.jobs.running || raw.jobs.processing || 0;
  const failed = raw.jobs.failed || 0;
  const state = !raw.embedding_configured || !raw.extraction_configured || failed > 0 ? "degraded" : "healthy";
  return {
    workspace: { id: raw.workspace_id, name: scope.workspaceName || raw.workspace_id },
    project: { id: raw.project_id, name: scope.projectName || raw.project_id },
    state,
    message: state === "degraded" ? "모델 연결 또는 실패한 처리 작업을 확인하세요." : undefined,
    counts: { records: raw.records, claims: raw.claims, sessions: raw.sessions },
    processing: { pending, running, failed },
    mcp: { url: raw.mcp_url || defaultMcpUrl(), state: raw.mcp_url ? "healthy" : "unknown" },
  };
}

export function normalizeRecall(raw: RawRecall): { items: RecallResult[] } {
  const records: RecallResult[] = raw.records.map(item => ({ id: item.record_id, kind: "record", content: item.matched_content || item.content, project_id: item.project_id }));
  const claims: RecallResult[] = raw.claims.map(item => ({ id: item.claim_id, kind: "claim", content: item.content, project_id: item.project_id, citations: item.evidence_ids.map(record_id => ({ record_id })) }));
  const relevance = new Map<string, number>([
    ...raw.records.map(item => [item.record_id, item.rrf_score ?? 1 / (60 + item.rank)] as const),
    ...raw.claims.map(item => [item.claim_id, item.rrf_score ?? 1 / (60 + item.rank)] as const),
  ]);
  return { items: [...records, ...claims].sort((a, b) => (relevance.get(b.id) || 0) - (relevance.get(a.id) || 0)) };
}

export function normalizeClaim(raw: RawClaim): Claim {
  return { id: raw.id, text: raw.content, status: raw.status, derivation_method: raw.derivation_method, project_id: raw.project_id, updated_at: raw.created_at };
}

export function normalizeClaimEvidence(raw: RawClaimEvidence): ClaimEvidence {
  return {
    claim: normalizeClaim(raw.claim),
    citations: raw.evidence.map(item => ({ record_id: item.record.id, label: item.role, excerpt: item.quote || item.record.content, source: item.record.source_app || undefined })),
  };
}

export function normalizeWiki(raw: RawWiki, scope: Scope): WikiDocument {
  return {
    title: scope.projectName || "프로젝트 Wiki",
    updated_at: raw.generated_at,
    sections: raw.sections.map((section, index) => ({
      id: `${index + 1}`,
      heading: section.title,
      body: section.claims.map(item => `• ${item.content}`).join("\n"),
      claim_ids: section.claims.map(item => item.claim_id),
    })),
  };
}

export function normalizeGraph(raw: RawGraph): KnowledgeGraph {
  return {
    nodes: raw.nodes,
    edges: raw.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, label: edge.predicate, claim_id: edge.claim_id })),
  };
}

export function normalizeRecordContext(raw: { target_record_id: string; records: RawRecord[] }): RecordContext {
  const index = Math.max(0, raw.records.findIndex(item => item.id === raw.target_record_id));
  const target = raw.records[index] || raw.records[0];
  if (!target) throw new ApiError("원본 기록을 찾지 못했습니다.", 404);
  return {
    id: target.id,
    kind: target.kind,
    content: target.content,
    source: target.source_app || undefined,
    occurred_at: target.occurred_at,
    project_id: target.project_id,
    before: index > 0 ? raw.records[index - 1]?.content : undefined,
    after: index < raw.records.length - 1 ? raw.records[index + 1]?.content : undefined,
  };
}

export function normalizeNode(raw: RawNode): NodeSummary {
  return {
    id: raw.node_id,
    name: raw.alias,
    state: normalizeNodePhase(raw.phase),
    version: raw.schema_revision,
    endpoint: `http://127.0.0.1:${raw.ports.dashboard}`,
  };
}

export function normalizeNodeHealth(raw: RawNodeHealth): NodeHealth {
  return {
    node: normalizeNode(raw.node),
    docker_available: raw.docker_available,
    phase: raw.phase,
    state: normalizeNodePhase(raw.phase),
    components: raw.components,
    endpoints: raw.endpoints,
    models: raw.models,
    error: raw.error,
    storage: { schema_revision: raw.node.schema_revision },
    updated_at: raw.node.updated_at,
  };
}

export function normalizeBacklog(raw: RawBacklog): NodeBacklog {
  const counts = raw.counts || {};
  return {
    node_id: raw.node_id,
    available: raw.available,
    pending: raw.pending ?? counts.pending ?? 0,
    running: raw.running ?? counts.running ?? 0,
    retrying: raw.retrying ?? counts.retry ?? 0,
    failed: raw.failed ?? counts.failed ?? 0,
    oldest_pending_at: raw.oldest_pending_at || undefined,
    oldest_pending_seconds: raw.oldest_pending_seconds,
    error: raw.error,
  };
}

export function normalizeBackup(raw: RawBackup): Backup {
  return {
    id: raw.backup_id,
    label: raw.label || `${raw.node_alias} · generation ${raw.generation}`,
    created_at: raw.created_at,
    size_bytes: raw.archive_bytes,
    state: raw.verified ? "verified" : "ready",
  };
}

export function normalizeRestorePlan(raw: RawRestorePlan): OperationPlan {
  const labels: Record<string, string> = {
    "Enter maintenance and stop all record writers": "유지보수 모드로 전환하고 모든 기록 입력을 잠시 멈춥니다.",
    "Create a final pre-restore backup while writers remain stopped": "입력이 멈춘 상태에서 현재 데이터를 마지막으로 백업합니다.",
    "Restore into a new PostgreSQL volume generation": "새 PostgreSQL 볼륨에 백업을 복원합니다.",
    "Verify schema, row counts, writes, reads, and vector search on a private stack": "분리된 환경에서 스키마·행 수·읽기·쓰기·벡터 검색을 검증합니다.",
    "Stop writers and atomically switch the active generation": "검증이 끝난 새 데이터 세대로 한 번에 전환합니다.",
    "Roll back to the previous generation if health verification fails": "상태 검증에 실패하면 기존 데이터 세대로 즉시 돌아갑니다.",
    "Preserve both the previous generation and the backup": "기존 데이터 세대와 백업은 자동 삭제하지 않고 보존합니다.",
  };
  return {
    allowed: raw.ok,
    title: "백업 복원 계획",
    summary: `현재 generation ${raw.current_generation}을 보존하고 generation ${raw.candidate_generation}에서 검증합니다.`,
    warnings: raw.blockers,
    steps: raw.steps.map(title => ({ title: labels[title] || title })),
  };
}

export function normalizeMigrationPlan(raw: RawMigrationPlan): OperationPlan {
  return {
    allowed: raw.ok,
    title: "스키마 이관 계획",
    summary: `${raw.current_revision} → ${raw.target_revision} · ${raw.apply_mode === "new_generation" ? "새 generation 검증" : "트랜잭션 적용"}`,
    warnings: raw.blockers,
    steps: [
      ...(raw.requires_backup ? [{ title: "현재 데이터를 백업합니다." }] : []),
      { title: `${raw.target_revision} 스키마를 준비합니다.` },
      { title: "읽기·쓰기·벡터 검색을 검증합니다." },
    ],
  };
}

function normalizeNodePhase(phase: RawNode["phase"]): NodeSummary["state"] {
  if (phase === "ready") return "healthy";
  if (phase === "failed") return "unavailable";
  if (phase === "maintenance") return "degraded";
  return phase;
}

function defaultMcpUrl() {
  if (typeof window === "undefined") return "http://127.0.0.1:18765/mcp";
  const host = ["127.0.0.1", "localhost"].includes(window.location.hostname) ? window.location.hostname : "127.0.0.1";
  return `http://${host}:18765/mcp`;
}

function managerRequest<T>(path: string, init: RequestInit = {}) {
  return request<T>(managerBase, path, { ...init, manager: true });
}

async function managerOperation(path: string, init: RequestInit) {
  const operation = await managerRequest<RawOperation>(path, init);
  if (operation.state === "failed") throw new ApiError(operation.error || "Node 작업에 실패했습니다.");
  return operation;
}

function requireOperationResult<T>(operation: RawOperation): T {
  if (operation.state === "failed") throw new ApiError(operation.error || "계획을 만들지 못했습니다.");
  if (!operation.result) throw new ApiError("관리 서비스가 계획 결과를 반환하지 않았습니다.");
  return operation.result as T;
}

function validLoopbackManager(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ApiError("관리 서비스 주소가 올바르지 않습니다."); }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "http:" || !loopback || !parsed.port || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ApiError("관리 서비스는 이 기기의 loopback 주소만 사용할 수 있습니다.");
  }
  return trimBase(parsed.origin);
}

export async function exchangeManagerBootstrap() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = fragment.get("neuromem-admin");
  const manager = fragment.get("manager");
  if (!token) return false;
  if (manager) managerBase = validLoopbackManager(manager);
  else if (window.location.pathname.startsWith("/admin")) managerBase = validLoopbackManager(`${window.location.origin}/`);

  // Keep the one-time token in memory only and remove it from browser history before the request.
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  await managerRequest<{ ok: boolean }>("/v1/admin/session", json({ token }));
  return true;
}

export const apiConfig = { coreBase, get managerBase() { return managerBase; } };
