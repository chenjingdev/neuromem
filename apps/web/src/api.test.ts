import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeManagerBootstrap,
  managerApi,
  teamApi,
  normalizeBackup,
  normalizeBacklog,
  normalizeGraph,
  normalizeMigrationPlan,
  normalizeNode,
  normalizeNodeHealth,
  normalizeOverview,
  normalizeRecall,
  normalizeRestorePlan,
  normalizeWiki,
} from "./api";

afterEach(() => vi.restoreAllMocks());

const rawNode = {
  node_id: "node-1",
  alias: "Personal",
  ports: { api: 18001, dashboard: 14173, mcp: 18765 },
  generation: 2,
  desired_state: "running" as const,
  phase: "ready" as const,
  compose_project: "neuromem-personal",
  schema_revision: "0001",
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T01:00:00Z",
};

const rawBackup = {
  backup_id: "backup-1",
  label: "before-update",
  node_id: "node-1",
  node_alias: "Personal",
  generation: 2,
  schema_revision: "0001",
  created_at: "2026-08-31T01:00:00Z",
  archive_bytes: 2048,
  verified: true,
};

describe("API response normalization", () => {
  it("maps manager node, health, and backup fields to UI types", () => {
    expect(normalizeNode(rawNode)).toMatchObject({ id: "node-1", name: "Personal", state: "healthy", version: "0001" });
    expect(normalizeNodeHealth({ node: rawNode, docker_available: true, phase: "ready", components: [{ name: "database", state: "running", health: "healthy" }], endpoints: { api: "http://127.0.0.1:18001" }, models: { embedding: { configured: true, model: "qwen3-embedding:4b", provider_status: "ready", provider_detail: null, last_probe_at: "2026-08-31T00:30:00Z" }, extraction: { configured: false, provider_status: "unconfigured", provider_detail: "generation provider not configured", last_probe_at: null } } })).toMatchObject({ state: "healthy", components: [{ name: "database" }], models: { embedding: { model: "qwen3-embedding:4b", provider_status: "ready" }, extraction: { configured: false } } });
    expect(normalizeBackup(rawBackup)).toMatchObject({ id: "backup-1", label: "before-update", size_bytes: 2048, state: "verified" });
    expect(normalizeBacklog({ node_id: "node-1", available: true, counts: { pending: 2, running: 1, retry: 3, failed: 4 } })).toMatchObject({ pending: 2, running: 1, retrying: 3, failed: 4 });
  });

  it("turns restore and migration raw plans into read-only plan cards", () => {
    const restore = normalizeRestorePlan({ ok: false, node_id: "node-1", backup: rawBackup, current_generation: 2, candidate_generation: 3, free_bytes: 10, required_bytes: 20, steps: ["Create staged volume"], blockers: ["Insufficient space"] });
    expect(restore).toMatchObject({ allowed: false, warnings: ["Insufficient space"], steps: [{ title: "Create staged volume" }] });
    expect(normalizeRestorePlan({ ok: true, node_id: "node-1", backup: rawBackup, current_generation: 2, candidate_generation: 3, free_bytes: 20, required_bytes: 10, steps: ["Enter maintenance and stop all record writers"], blockers: [] }).steps[0].title).toMatch(/유지보수/);
    const migration = normalizeMigrationPlan({ ok: true, node_id: "node-1", current_revision: "0001", target_revision: "0002", requires_backup: true, apply_mode: "new_generation", blockers: [] });
    expect(migration.allowed).toBe(true);
    expect(migration.steps.map(step => step.title)).toContain("현재 데이터를 백업합니다.");
  });

  it("reads provider choices, probes a generation connection, and posts the selected source", async () => {
    const modelSelection = {
      node_id: "node/with space",
      embedding: { model: "embed-old", available_models: ["embed-old", "embed-new"], diagnostic: null },
      generation: {
        active_source: "codex_session",
        model: "gpt-5.4",
        available_models: ["gpt-5.4"],
        diagnostic: null,
        sources: {
          codex_session: { available: true, auth_status: "signed_in", plan_type: "pro", available_models: ["gpt-5.4"], diagnostic: null, last_checked_at: "2026-08-31T01:00:00Z" },
          openai_compatible: { configured: true, connection_origin: "generation", display_base_url: "http://127.0.0.1:11434/v1", api_key_configured: false, model: "gpt-oss:20b", available_models: ["gpt-oss:20b"], diagnostic: null, last_checked_at: "2026-08-31T01:00:00Z" },
        },
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(
      String(input).endsWith("/generation/probe")
        ? { source: "openai_compatible", available_models: ["gpt-oss:20b"], model_compatible: true, diagnostic: null }
        : init?.method === "POST"
          ? { ok: true, state: "succeeded", result: { restarted: true } }
          : modelSelection,
    ), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(managerApi.models("node/with space")).resolves.toEqual(modelSelection);
    await expect(managerApi.probeGeneration("node/with space", { source: "openai_compatible", model: "gpt-oss:20b", connection: { base_url: "http://127.0.0.1:11434/v1", api_key_action: "keep" } })).resolves.toMatchObject({ model_compatible: true });
    await expect(managerApi.configureModels("node/with space", { generation: { source: "codex_session", model: "gpt-5.4" } })).resolves.toMatchObject({ state: "succeeded" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/v1\/nodes\/node%2Fwith%20space\/models$/);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ source: "openai_compatible", model: "gpt-oss:20b", connection: { base_url: "http://127.0.0.1:11434/v1", api_key_action: "keep" } }),
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ generation: { source: "codex_session", model: "gpt-5.4" } }),
    });
    expect(String(fetchMock.mock.calls[2]?.[1]?.body)).not.toMatch(/base_url|api_key/i);
  });

  it("normalizes core overview, recall, wiki, and graph contracts", () => {
    const scope = { workspaceId: "workspace-1", projectId: "project-1", workspaceName: "개인", projectName: "Neuromem" };
    const overview = normalizeOverview({ workspace_id: "workspace-1", project_id: "project-1", records: 12, claims: 4, sessions: 2, peers: 1, jobs: { pending: 3, running: 1, failed: 0 }, embedding_configured: true, extraction_configured: true }, scope);
    expect(overview).toMatchObject({ state: "healthy", project: { name: "Neuromem" }, processing: { pending: 3, running: 1, failed: 0 } });

    const recall = normalizeRecall({ records: [{ record_id: "record-1", project_id: "project-1", content: "whole", matched_content: "matched", rank: 2 }], claims: [{ claim_id: "claim-1", project_id: "project-1", content: "decision", status: "active", derivation_method: "explicit", evidence_ids: ["record-1"], rank: 1 }] });
    expect(recall.items.map(item => item.id)).toEqual(["claim-1", "record-1"]);
    expect(recall.items[0].citations).toEqual([{ record_id: "record-1" }]);

    const wiki = normalizeWiki({ project_id: "project-1", generated_at: "2026-08-31T00:00:00Z", sections: [{ title: "결정", claims: [{ claim_id: "claim-1", content: "2560차원을 사용한다", evidence_count: 1, updated_at: "2026-08-31T00:00:00Z" }] }] }, scope);
    expect(wiki).toMatchObject({ title: "Neuromem", sections: [{ heading: "결정", claim_ids: ["claim-1"] }] });

    const graph = normalizeGraph({ nodes: [{ id: "entity-1", type: "project", label: "Neuromem" }], edges: [{ id: "edge-1", claim_id: "claim-1", source: "entity-1", predicate: "USES", target: "entity-2" }] });
    expect(graph.edges[0]).toMatchObject({ label: "USES", claim_id: "claim-1" });
  });

  it("exchanges the one-time admin fragment without persisting it", async () => {
    window.history.replaceState(null, "", "/admin/#neuromem-admin=one-time-secret&manager=http%3A%2F%2F127.0.0.1%3A14174");
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeManagerBootstrap()).resolves.toBe(true);
    expect(window.location.hash).toBe("");
    expect(localStorage.getItem("neuromem-admin")).toBeNull();
    expect(sessionStorage.getItem("neuromem-admin")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:14174/v1/admin/session", expect.objectContaining({ credentials: "include", body: JSON.stringify({ token: "one-time-secret" }) }));
  });
});

describe("team product API", () => {
  it("loads team, peer, credential, grant, federation, and transfer data through the product session", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      let body: unknown = { items: [] };
      if (url.endsWith("/workspaces/workspace-1/members")) body = [{ id: "member-1", workspace_id: "workspace-1", principal_id: "principal-1", role: "owner", status: "active" }];
      else if (url.endsWith("/workspaces/workspace-1/peer-bindings")) body = [{ principal_id: "principal-1", peer: { id: "human-1", workspace_id: "workspace-1", name: "Aram", kind: "human", status: "active" }, kind: "primary_human", status: "active" }, { principal_id: null, peer: { id: "agent-1", workspace_id: "workspace-1", name: "Aram Codex", kind: "agent", status: "active" }, kind: "agent_owner", client: "codex", owner_principal_id: "principal-1", status: "active" }];
      else if (url.endsWith("/credentials")) body = [{ id: "credential-1", name: "Codex", token_prefix: "nmem_1234", kind: "mcp", workspace_id: "workspace-1", project_ids: ["project-1"], principal_id: "principal-1", agent_peer_id: "agent-1", capabilities: ["memory:read"] }];
      else if (url.endsWith("/projects/project-1/grants")) body = { items: [{ id: "grant-1", project_id: "project-1", principal_id: "principal-1", capabilities: ["memory:read"] }] };
      else if (url.endsWith("/workspace-links")) body = [{ id: "link-1", source_workspace_id: "workspace-1", target_workspace_id: "workspace-2", status: "active" }];
      else if (url.endsWith("/federated-project-grants")) body = [{ id: "fgrant-1", workspace_link_id: "link-1", source_project_id: "external-project", target_workspace_id: "workspace-1", capabilities: ["search"], status: "active" }];
      else if (url.includes("/transfer-requests?")) body = [{ id: "transfer-1", source_workspace_id: "workspace-2", source_project_id: "external-project", target_workspace_id: "workspace-1", target_project_id: "project-1", source_record_id: "record-1", provenance: { reason: "approved context" }, status: "pending_target" }];
      else throw new Error(`Unexpected URL ${url}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const dashboard = await teamApi.dashboard({ workspaceId: "workspace-1", projectId: "project-1" });
    expect(dashboard.members[0]).toMatchObject({ display_name: "Aram", agent_peers: [{ client: "codex" }] });
    expect(dashboard.peer_bindings[0].agent_peers[0]).toMatchObject({ client: "codex" });
    expect(dashboard.credentials[0]).toMatchObject({ human_peer_id: "human-1", agent_peer_id: "agent-1" });
    expect(dashboard.transfer_requests[0]).toMatchObject({ status: "pending_target" });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls.every(call => call[1]?.credentials === "include" && (call[1]?.headers as Record<string, string>)["x-neuromem-workspace"] === "workspace-1")).toBe(true);
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/api\/v1\/workspaces\/workspace-1\/members$/),
      expect.stringMatching(/\/api\/v1\/projects\/project-1\/grants$/),
    ]));
  });

  it("creates a credential and resolves a transfer without placing secrets in URLs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(
      String(input).includes("transfer-1")
        ? { id: "transfer-1", status: "approved" }
        : { credential: { id: "credential-1", name: "Aram Codex", token_prefix: "nmem_1234", kind: "mcp", workspace_id: "workspace-1", project_ids: ["project-1"], principal_id: "principal-1", agent_peer_id: "agent-1", capabilities: ["memory:read"] }, token: "one-time-secret" },
    ), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(teamApi.createCredential({ workspace_id: "workspace-1", project_id: "project-1", name: "Aram Codex", client: "codex", agent_peer_id: "agent-1", capabilities: ["memory:read"] })).resolves.toMatchObject({ secret: "one-time-secret" });
    await teamApi.resolveTransferRequest({ workspaceId: "workspace-1", projectId: "project-1" }, "transfer-1", "approve");

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/credentials$/);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("one-time-secret");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/api\/v1\/transfer-requests\/transfer-1:approve$/);
  });
});
